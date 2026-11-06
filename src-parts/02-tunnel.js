
/* ============================================================
 * TUNNEL CORE — the BPB-VPN pattern, verbatim in spirit:
 *   • settings as a parameter (never shared globals)
 *   • TCP only (command must be 1) — DNS travels as DoH over TCP
 *   • every fire-and-forget promise carries a .catch
 *   • safeClose* never throws
 * ============================================================ */

function handleWebsocket(request, settings) {
    const pathname = new URL(request.url).pathname;
    const proto = pathname.split('/')[1];

    if (proto === 'vl') return vOverWS(request, settings);
    if (proto === 'tr') return trOverWS(request, settings);
    return wsFallback(request, settings);
}

async function wsFallback(request, settings) {
    if (settings.fallback) {
        try {
            const target = new URL(settings.fallback.startsWith('http') ? settings.fallback : `https://${settings.fallback}`);
            const url = new URL(request.url);
            url.protocol = 'https:';
            url.hostname = target.hostname;
            url.port = target.port;
            return fetch(new Request(url, request));
        } catch { /* fall through */ }
    }
    return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
}

async function vOverWS(request, settings) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();
    webSocket.binaryType = 'arraybuffer';

    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader);

    const remoteSocket = { value: null };

    readableWebSocketStream
        .pipeTo(new WritableStream({
            async write(chunk) {
                if (remoteSocket.value) {
                    const writer = remoteSocket.value.writable.getWriter();
                    await writer.write(chunk);
                    writer.releaseLock();
                    return;
                }

                const header = parseVlHeader(chunk, settings.vlUUID);
                if (header.hasError) throw new Error(header.message);

                const responseHeader = new Uint8Array([header.version[0], 0]);
                const rawClientData = chunk.slice(header.rawDataIndex);

                handleTCPOutBound(remoteSocket, header.addressRemote, header.portRemote, rawClientData, webSocket, responseHeader, settings);
            },
            close() {
                safeCloseTcpSocket(remoteSocket.value);
            },
        }))
        .catch(() => safeCloseTcpSocket(remoteSocket.value));

    // Xray drops a connection whose early-data subprotocol is not echoed.
    const headers = earlyDataHeader ? { 'Sec-WebSocket-Protocol': earlyDataHeader } : undefined;
    return new Response(null, { status: 101, webSocket: client, headers });
}

async function trOverWS(request, settings) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();
    webSocket.binaryType = 'arraybuffer';

    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader);

    const remoteSocket = { value: null };

    readableWebSocketStream
        .pipeTo(new WritableStream({
            async write(chunk) {
                if (remoteSocket.value) {
                    const writer = remoteSocket.value.writable.getWriter();
                    await writer.write(chunk);
                    writer.releaseLock();
                    return;
                }

                const header = parseTrHeader(chunk, settings.trPass);
                if (header.hasError) throw new Error(header.message);

                handleTCPOutBound(remoteSocket, header.addressRemote, header.portRemote, header.rawClientData, webSocket, null, settings);
            },
            close() {
                safeCloseTcpSocket(remoteSocket.value);
            },
        }))
        .catch(() => safeCloseTcpSocket(remoteSocket.value));

    const headers = earlyDataHeader ? { 'Sec-WebSocket-Protocol': earlyDataHeader } : undefined;
    return new Response(null, { status: 101, webSocket: client, headers });
}

function parseVlHeader(buffer, userId) {
    if (buffer.byteLength < 24) return { hasError: true, message: 'invalid data' };

    const bytes = new Uint8Array(buffer);
    const version = bytes.slice(0, 1);
    if (uuidFromBytes(bytes, 1) !== userId) return { hasError: true, message: 'invalid user' };

    const optLength = bytes[17];
    const command = bytes[18 + optLength];
    // TCP only, exactly like BPB-VPN: DNS resolves as DoH over the tunnel itself.
    if (command !== 1) return { hasError: true, message: `command ${command} is not supported` };

    const portIndex = 18 + optLength + 1;
    const portRemote = new DataView(buffer.slice(portIndex, portIndex + 2)).getUint16(0);

    const addressType = bytes[portIndex + 2];
    let addressValueIndex = portIndex + 3;
    let addressLength = 0;
    let addressRemote = '';

    switch (addressType) {
        case 1:
            addressLength = 4;
            addressRemote = bytes.slice(addressValueIndex, addressValueIndex + 4).join('.');
            break;
        case 2:
            addressLength = bytes[addressValueIndex];
            addressValueIndex += 1;
            addressRemote = new TextDecoder().decode(buffer.slice(addressValueIndex, addressValueIndex + addressLength));
            break;
        case 3: {
            addressLength = 16;
            const view = new DataView(buffer.slice(addressValueIndex, addressValueIndex + 16));
            const parts = [];
            for (let i = 0; i < 8; i++) parts.push(view.getUint16(i * 2).toString(16));
            addressRemote = parts.join(':');
            break;
        }
        default:
            return { hasError: true, message: `invalid address type ${addressType}` };
    }

    if (!addressRemote) return { hasError: true, message: 'empty address' };

    return {
        hasError: false,
        addressRemote,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        version,
    };
}

function parseTrHeader(buffer, trPass) {
    if (buffer.byteLength < 56) return { hasError: true, message: 'invalid data' };

    let crLfIndex = 56;
    const cr = new Uint8Array(buffer.slice(crLfIndex, crLfIndex + 1))[0];
    const lf = new Uint8Array(buffer.slice(crLfIndex + 1, crLfIndex + 2))[0];

    if (cr !== 0x0d || lf !== 0x0a) {
        return { hasError: true, message: 'invalid header format (missing CR LF)' };
    }

    const password = new TextDecoder().decode(buffer.slice(0, crLfIndex));
    if (password !== sha224Hex(trPass)) {
        return { hasError: true, message: 'invalid password' };
    }

    const socks5DataBuffer = buffer.slice(crLfIndex + 2);
    if (socks5DataBuffer.byteLength < 6) {
        return { hasError: true, message: 'invalid SOCKS5 request data' };
    }

    const view = new DataView(socks5DataBuffer);
    const cmd = view.getUint8(0);
    if (cmd !== 1) {
        return { hasError: true, message: 'unsupported command, only TCP (CONNECT) is allowed' };
    }

    const atype = view.getUint8(1);
    let addressLength = 0;
    let addressIndex = 2;
    let addressRemote = '';

    switch (atype) {
        case 1:
            addressLength = 4;
            addressRemote = new Uint8Array(socks5DataBuffer.slice(addressIndex, addressIndex + addressLength)).join('.');
            break;
        case 2:
            addressLength = new Uint8Array(socks5DataBuffer.slice(addressIndex, addressIndex + 1))[0];
            addressIndex += 1;
            addressRemote = new TextDecoder().decode(socks5DataBuffer.slice(addressIndex, addressIndex + addressLength));
            break;
        case 3: {
            addressLength = 16;
            const dataView = new DataView(socks5DataBuffer.slice(addressIndex, addressIndex + addressLength));
            const ipv6 = [];
            for (let i = 0; i < 8; i++) ipv6.push(dataView.getUint16(i * 2).toString(16));
            addressRemote = ipv6.join(':');
            break;
        }
        default:
            return { hasError: true, message: `invalid addressType is ${atype}` };
    }

    if (!addressRemote) {
        return { hasError: true, message: `addressValue is empty, addressType is ${atype}` };
    }

    const portIndex = addressIndex + addressLength;
    const portRemote = new DataView(socks5DataBuffer.slice(portIndex, portIndex + 2)).getUint16(0);

    return {
        hasError: false,
        addressRemote,
        portRemote,
        rawClientData: socks5DataBuffer.slice(portIndex + 2),
    };
}

const BYTE_TO_HEX = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));

function uuidFromBytes(arr, offset) {
    const h = (i) => BYTE_TO_HEX[arr[offset + i]];
    return (
        h(0) + h(1) + h(2) + h(3) + '-' + h(4) + h(5) + '-' + h(6) + h(7) + '-' +
        h(8) + h(9) + '-' + h(10) + h(11) + h(12) + h(13) + h(14) + h(15)
    );
}

async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader, settings) {
    async function connectAndWrite(address, port) {
        if (address.includes(':') && !address.startsWith('[')) address = `[${address}]`;
        const tcpSocket = connect({ hostname: address, port });
        remoteSocket.value = tcpSocket;
        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();
        return tcpSocket;
    }

    function safeWsClose(code, reason) {
        try {
            webSocket.close(code, reason);
        } catch { /* already closed */ }
    }

    // The retry path — every step inside try/catch, including the DoH
    // resolution used by prefix mode (the classic 1101 source in the old panels).
    async function retry() {
        let retryAddress = addressRemote;
        let retryPort = portRemote;

        try {
            if (settings.proxyIpMode === 'prefix' && settings.prefixes.length) {
                const prefix = settings.prefixes[Math.floor(Math.random() * settings.prefixes.length)];
                const dynamic = await getDynamicNAT64(addressRemote, prefix, settings.dohUrl);
                if (dynamic) retryAddress = dynamic;
                else return safeWsClose(1011, 'Retry connection failed: Invalid Prefix');
            } else if (settings.proxyIPs.length) {
                const endpoint = settings.proxyIPs[Math.floor(Math.random() * settings.proxyIPs.length)];
                const { host, port } = parseHostPort(endpoint);
                if (host) retryAddress = host;
                if (port) retryPort = port;
            }

            const tcpSocket = await connectAndWrite(retryAddress, retryPort);
            tcpSocket.closed
                .catch(() => { })
                .finally(() => safeCloseWebSocket(webSocket));
            remoteSocketToWS(tcpSocket, webSocket, responseHeader, null, settings);
        } catch (error) {
            safeWsClose(1011, `Retry failed: ${safeError(error)}`);
        }
    }

    try {
        const tcpSocket = await connectAndWrite(addressRemote, portRemote);
        remoteSocketToWS(tcpSocket, webSocket, responseHeader, retry, settings);
    } catch (error) {
        safeWsClose(1011, `Connection failed: ${safeError(error)}`);
    }
}

async function remoteSocketToWS(remoteSocket, webSocket, responseHeader, retry, settings) {
    let header = responseHeader;
    let hasIncomingData = false;

    try {
        await remoteSocket.readable.pipeTo(new WritableStream({
            async write(chunk, controller) {
                hasIncomingData = true;
                if (webSocket.readyState !== WS_READY_STATE_OPEN) {
                    controller.error('WebSocket is not open');
                }
                if (header) {
                    webSocket.send(await new Blob([header, chunk]).arrayBuffer());
                    header = null;
                } else {
                    webSocket.send(chunk);
                }
            },
            abort() {
                safeCloseTcpSocket(remoteSocket);
            },
        }));
    } catch {
        safeCloseTcpSocket(remoteSocket);
        safeCloseWebSocket(webSocket);
        return;
    }

    if (!hasIncomingData && retry) {
        try {
            await retry();
        } catch { /* retry guards itself */ }
    }
}

function makeReadableWebSocketStream(webSocket, earlyDataHeader) {
    let cancelled = false;
    return new ReadableStream({
        start(controller) {
            webSocket.addEventListener('message', (event) => {
                if (!cancelled) controller.enqueue(event.data);
            });
            webSocket.addEventListener('close', () => {
                safeCloseWebSocket(webSocket);
                if (!cancelled) controller.close();
            });
            webSocket.addEventListener('error', (err) => controller.error(err));

            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) controller.error(error);
            else if (earlyData) controller.enqueue(earlyData);
        },
        cancel(reason) {
            if (cancelled) return;
            cancelled = true;
            safeCloseWebSocket(webSocket);
        },
    });
}

function base64ToArrayBuffer(base64Str) {
    if (!base64Str) return { earlyData: null, error: null };
    try {
        const decoded = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
        return { earlyData: Uint8Array.from(decoded, (c) => c.charCodeAt(0)).buffer, error: null };
    } catch (error) {
        return { earlyData: null, error };
    }
}

function safeCloseTcpSocket(socket) {
    try {
        if (socket) socket.close();
    } catch { /* ignore */ }
}

function safeCloseWebSocket(socket) {
    try {
        if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
            socket.close();
        }
    } catch { /* ignore */ }
}

function parseHostPort(input) {
    const match = String(input).trim().match(/^(?:\[(?<ipv6>.+?)\]|(?<host>[^:]+))(?::(?<port>\d+))?$/);
    if (!match) return { host: String(input).trim(), port: 443 };
    const { ipv6, host, port } = match.groups;
    return {
        host: ipv6 ? `[${ipv6}]` : host,
        port: port ? Number(port) : 443,
    };
}

function isIPv4(str) {
    const parts = String(str).split('.');
    return parts.length === 4 && parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

/** Resolve an A record through DoH — used ONLY inside the guarded retry path. */
async function resolveIPv4viaDoH(domain, dohUrl) {
    const base = dohUrl || 'https://cloudflare-dns.com/dns-query';
    const url = base.includes('?')
        ? `${base}&name=${encodeURIComponent(domain)}&type=A`
        : `${base}?name=${encodeURIComponent(domain)}&type=A`;
    const resp = await fetch(url, { headers: { accept: 'application/dns-json' } });
    const data = await resp.json();
    if (!data || !Array.isArray(data.Answer)) return null;
    const record = data.Answer.find((r) => r.type === 1);
    return record ? record.data : null;
}

function convertToNAT64IPv6(ipv4Address, prefix) {
    const parts = ipv4Address.split('.');
    if (parts.length !== 4) throw new Error('Invalid IPv4 address');
    const hex = parts.map((p) => {
        const n = Number(p);
        if (Number.isNaN(n) || n < 0 || n > 255) throw new Error('Invalid IPv4 address');
        return n.toString(16).padStart(2, '0');
    });
    const match = prefix.match(/^\[([0-9A-Fa-f:]+)\]$/);
    if (match) return `[${match[1]}${hex[0]}${hex[1]}:${hex[2]}${hex[3]}]`;
    const bare = prefix.replace(/^\[|\]$/g, '');
    return `[${bare}${hex[0]}${hex[1]}:${hex[2]}${hex[3]}]`;
}

async function getDynamicNAT64(address, prefix, dohUrl) {
    let finalAddress = address;
    if (!isIPv4(address)) {
        const ipv4 = await resolveIPv4viaDoH(address, dohUrl);
        if (!ipv4) return null;
        finalAddress = ipv4;
    }
    return convertToNAT64IPv6(finalAddress, prefix);
}
