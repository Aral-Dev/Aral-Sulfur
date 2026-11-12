/**
 * ARAL SULFUR — Multi-core Subscription & Access Pass Generator.
 *
 * Supports:
 *   - Standard Base64 & Raw URI subscriptions (VLESS + Trojan + Shadowsocks × Clean IPs × Ports × Locations)
 *   - Xray-core Full JSON array with Fragment (`sockopt.dialerProxy = "fragment"`) & Routing
 *   - Sing-box / Hiddify JSON profile (universal rule syntax, zero external SRS dependency)
 *   - Clash Meta / Mihomo / FlClash YAML profile
 *   - Bilingual (FA/EN) 1950s Newsprint HTML Subscriber Press Pass (`/sub/<token>` in browsers)
 *   - 1950s New York Midnight Gazette stealth front page (`rootMode === 'gazette'`)
 *
 * ULTRA V4: per-user fragment / fingerprint / pattern (fm) / cipher-suites (cs) / TLS mask /
 * ECH params, multi-location `/loc-N` paths, per-user clean-IP rotation and ss nodes.
 */

import { utf8ToBase64 } from './crypto.js';
import { enrichUserView, PANEL_BRAND, PANEL_VERSION } from './storage.js';
import { parseEndpoint } from './protocols.js';
import { buildTgProxyFullLinks } from './tgproxy.js';
import { rotateCleanAddresses } from './pools.js';

export const FREE_NOTICE_FA = '[ARAL] کپی‌برداری و فروش این سرویس ممنوع است';
export const FREE_NOTICE_FULL =
  '[ARAL] کپی‌برداری، بازفروش و انتشار تجاری این پروژه ممنوع است.\nCopying, reselling or commercial redistribution of this project is prohibited.';

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

function parseCleanEntry(raw) {
  const str = String(raw || '').trim();
  if (!str) return null;
  const hashIdx = str.indexOf('#');
  const addrPart = (hashIdx >= 0 ? str.slice(0, hashIdx) : str).trim();
  const remark = (hashIdx >= 0 ? str.slice(hashIdx + 1) : '').trim();
  const ep = parseEndpoint(addrPart, 0);
  if (!ep || !ep.host) return null;
  const hostClean = ep.host.replace(/^\[|\]$/g, '');
  return {
    address: hostClean,
    portOverride: ep.explicitPort ? ep.port : 0,
    remark: remark || hostClean,
  };
}

// Scanner stores an approximate GeoIP ISO-2 tag after #, e.g. 172.67.73.163#NL|Scan.
// The flag is intentionally confined to subscription NODE NAMES; no connection field changes.
function cleanIpNodeLabel(entry) {
  const match = String(entry.remark || '').match(/^([A-Z]{2})\|(.*)$/i);
  const isIp = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(entry.address) || entry.address.includes(':');
  if (!match || !isIp) return entry.remark || entry.address;
  const cc = match[1].toUpperCase();
  const flag = String.fromCodePoint(...[...cc].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
  const note = match[2].trim();
  return `${flag} ${cc} · ${entry.address}${note ? ` · ${note}` : ''}`;
}

export function buildWsPath(settings) {
  const base = (settings.wsPath || '/').split('?')[0] || '/';
  if (settings.earlyData && Number(settings.earlyData) > 0) {
    return `${base}?ed=${Number(settings.earlyData)}`;
  }
  return base;
}

/* ULTRA: per-user clean-IP rotation — hydrates `ips` from community pools before node build */
export async function hydrateUserAddresses(env, userView, settings) {
  if (!userView) return userView;
  const explicit = Array.isArray(userView.ips) && userView.ips.length > 0;
  if (!userView.autoRotateIps || explicit) return userView;
  try {
    const { list } = await rotateCleanAddresses(env, userView, settings);
    if (list && list.length) {
      return { ...userView, ips: list };
    }
  } catch {}
  return userView;
}

/* ULTRA: effective protocol flags for a user view */
function userProtocolFlags(userView, settings) {
  if (userView.protocols) {
    const set = new Set(String(userView.protocols).split(',').filter(Boolean));
    return {
      vless: set.has('vless'),
      trojan: set.has('trojan'),
      ss: set.has('ss'),
    };
  }
  return {
    vless: settings.enableVless !== false,
    trojan: Boolean(settings.enableTrojan),
    ss: Boolean(settings.enableSS),
  };
}

/* ULTRA: per-user effective anti-DPI parameters */
function userDpiParams(userView, settings) {
  return {
    fingerprint: userView.fingerprint || settings.fingerprint || 'chrome',
    fragEnabled: !userView.fragDisabled && Boolean(settings.enableFragment),
    fragPackets: userView.fragPackets || settings.fragmentPackets || '1-1',
    fragLength: userView.fragLength || settings.fragmentLength || '10-20',
    fragInterval: userView.fragInterval || settings.fragmentInterval || '10-20',
    advancedFrag: userView.advancedFrag || '',
    cipherSuites: userView.cipherSuites || '',
    tlsMask: userView.tlsMask || '',
    ech: userView.ech || '',
  };
}

const TLS_PORT_UNIVERSE = new Set([443, 2053, 2083, 2087, 2096, 8443]);
const HTTP_PORT_UNIVERSE = new Set([80, 8080, 8880, 2052, 2082, 2086, 2095]);

/**
 * ULTRA: per-user port override. When `user.ports` is a non-empty CSV
 * (e.g. "443,8443" or "2053,80"), the subscriber's nodes are emitted ONLY on those
 * ports — split automatically into TLS / HTTP groups. Choosing an HTTP-only list
 * (e.g. "80") implies non-TLS nodes for that user even when the global toggle is off.
 */
function userPortLists(user, settings) {
  const globalTls = settings.tlsPorts?.length ? [...new Set(settings.tlsPorts.map(Number))] : [443];
  const globalHttp = settings.httpPorts?.length ? [...new Set(settings.httpPorts.map(Number))] : [80];
  const raw = String(user?.ports || '').trim();
  if (!raw) {
    return { tlsPorts: globalTls, httpPorts: globalHttp, httpEnabled: Boolean(settings.enableHttpPorts) };
  }
  const picked = raw.split(/[\s,;]+/).map(Number).filter((p) => Number.isInteger(p));
  const tlsPorts = picked.filter((p) => TLS_PORT_UNIVERSE.has(p));
  const httpPorts = picked.filter((p) => HTTP_PORT_UNIVERSE.has(p));
  const finalTls = tlsPorts.length ? tlsPorts : globalTls.filter((p) => picked.includes(p));
  const finalHttp = httpPorts.length ? httpPorts : [];
  return {
    tlsPorts: finalTls.length ? finalTls : [443],
    httpPorts: finalHttp,
    httpEnabled: finalHttp.length > 0,
  };
}

/**
 * Fast O(1) node-count & primary URI summary for `/api/bootstrap` so admin API calls
 * stay well under 2ms CPU even with dozens of subscribers and Clean IPs.
 */
export function computeQuickUserNodeMeta(user, settings, requestHost) {
  const hostOnly = String(requestHost || 'localhost').split(':')[0];
  const wsPath = buildWsPath(settings);
  const { tlsPorts: allTlsPorts, httpPorts: allHttpPorts, httpEnabled: httpPortsOn } = userPortLists(user, settings);
  const firstPort = allTlsPorts[0] || 443;
  const protoFlags = userProtocolFlags(user, settings);
  const dpi = userDpiParams(user, settings);

  let tlsPortSlots = allTlsPorts.length;
  let httpEndpointCount = 1;

  for (const d of settings.customDomains || []) {
    const parsed = parseCleanEntry(d);
    if (!parsed || parsed.address.toLowerCase() === hostOnly.toLowerCase()) continue;
    tlsPortSlots += parsed.portOverride ? 1 : allTlsPorts.length;
    httpEndpointCount += 1;
  }
  const cleanSource = (Array.isArray(user.ips) && user.ips.length ? user.ips : (settings.cleanIPs || []));
  for (const item of cleanSource) {
    const parsed = parseCleanEntry(item);
    if (!parsed) continue;
    tlsPortSlots += parsed.portOverride ? 1 : allTlsPorts.length;
    httpEndpointCount += 1;
  }

  const locCount = Array.isArray(user.proxyList)
    ? user.proxyList.filter((x) => x && String(x.proxy || '').trim()).length
    : 0;
  const locMultiplier = Math.max(1, locCount + 1);

  const httpPortSlots = httpPortsOn ? httpEndpointCount * allHttpPorts.length : 0;
  const rawCount =
    ((protoFlags.vless ? tlsPortSlots + httpPortSlots : 0) +
      (protoFlags.trojan ? tlsPortSlots : 0) +
      (protoFlags.ss ? tlsPortSlots : 0)) * locMultiplier;
  const nodeCount = Math.min(200, rawCount);

  const encPath = encodeURIComponent(wsPath);
  const fp = encodeURIComponent(dpi.fingerprint);
  const alpn = encodeURIComponent(settings.alpn || 'http/1.1');

  // Uniform watermark remark: protocol + ARAL SULFUR brand only — no host, port, flag or extra metadata.
  const vName = `${PANEL_BRAND} | VLESS`;
  const primaryVless = protoFlags.vless
    ? `vless://${user.uuid}@${hostOnly}:${firstPort}?encryption=none&security=tls&sni=${hostOnly}&fp=${fp}&alpn=${alpn}&type=ws&host=${hostOnly}&path=${encPath}#${encodeURIComponent(vName)}`
    : '';

  const tName = `${PANEL_BRAND} | Trojan`;
  const primaryTrojan = protoFlags.trojan
    ? `trojan://${encodeURIComponent(user.trojanPassword)}@${hostOnly}:${firstPort}?security=tls&sni=${hostOnly}&fp=${fp}&alpn=${alpn}&type=ws&host=${hostOnly}&path=${encPath}#${encodeURIComponent(tName)}`
    : '';

  return { nodeCount, primaryVless, primaryTrojan };
}

/**
 * Expand Clean IPs × Custom Domains × ALL Selected Ports × Enabled Protocols into clean node objects.
 */
export function buildNodeDescriptors(user, settings, requestHost) {
  const hostOnly = String(requestHost || 'localhost').split(':')[0];
  const wsPath = buildWsPath(settings);
  const cleanWsPath = (settings.wsPath || '/').split('?')[0] || '/';
  const alpnList = String(settings.alpn || 'http/1.1').split(',').map((s) => s.trim()).filter(Boolean);
  const { tlsPorts: allTlsPorts, httpPorts: allHttpPorts, httpEnabled: userHttpOn } = userPortLists(user, settings);
  const protoFlags = userProtocolFlags(user, settings);
  const dpi = userDpiParams(user, settings);

  // ULTRA: multi-location exit proxies — each entry gets its own /loc-N path contract
  const locations = [{ index: -1, proxy: '', country: '' }];
  if (Array.isArray(user.proxyList)) {
    for (let i = 0; i < user.proxyList.length; i++) {
      const entry = user.proxyList[i];
      if (entry && String(entry.proxy || '').trim()) {
        locations.push({ index: i, proxy: String(entry.proxy).trim(), country: String(entry.country || '').toUpperCase() });
      }
    }
  }
  const locSuffix = (locIndex) => (locIndex >= 0 ? `/loc-${locIndex}` : '');
  const flagLabel = (country) => {
    if (!/^[A-Z]{2}$/.test(country)) return '';
    return String.fromCodePoint(...[...country].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
  };

  const targets = [];

  // 1) Primary Worker/Pages domain across ALL selected TLS ports
  targets.push({
    address: hostOnly,
    sni: hostOnly,
    hostHeader: hostOnly,
    tagLabel: hostOnly,
    ports: allTlsPorts,
    tls: true,
  });

  // 2) Custom domains across ALL selected TLS ports (unless explicit :port specified)
  const parsedCustomDomains = [];
  for (const d of settings.customDomains || []) {
    const parsed = parseCleanEntry(d);
    if (!parsed || parsed.address.toLowerCase() === hostOnly.toLowerCase()) continue;
    parsedCustomDomains.push(parsed);
    targets.push({
      address: parsed.address,
      sni: parsed.address,
      hostHeader: parsed.address,
      tagLabel: parsed.remark || parsed.address,
      ports: parsed.portOverride ? [parsed.portOverride] : allTlsPorts,
      tls: true,
    });
  }

  // 3) ULTRA: per-user clean addresses (rotation or explicit list) — falls back to global Clean IPs
  const cleanSource = (Array.isArray(user.ips) && user.ips.length ? user.ips : (settings.cleanIPs || []));
  const parsedCleanEntries = [];
  for (const item of cleanSource) {
    const parsed = parseCleanEntry(item);
    if (!parsed) continue;
    parsedCleanEntries.push(parsed);
    targets.push({
      address: parsed.address,
      sni: hostOnly,
      hostHeader: hostOnly,
      tagLabel: cleanIpNodeLabel(parsed),
      ports: parsed.portOverride ? [parsed.portOverride] : allTlsPorts,
      tls: true,
    });
  }

  // 4) Non-TLS Cloudflare HTTP ports across Primary + Custom Domains + Clean IPs when enabled
  if ((settings.enableHttpPorts || userHttpOn) && allHttpPorts.length) {
    targets.push({
      address: hostOnly,
      sni: '',
      hostHeader: hostOnly,
      tagLabel: hostOnly,
      ports: allHttpPorts,
      tls: false,
    });
    for (const parsed of parsedCustomDomains) {
      targets.push({
        address: parsed.address,
        sni: '',
        hostHeader: parsed.address,
        tagLabel: parsed.remark || parsed.address,
        ports: parsed.portOverride ? [parsed.portOverride] : allHttpPorts,
        tls: false,
      });
    }
    for (const parsed of parsedCleanEntries) {
      targets.push({
        address: parsed.address,
        sni: '',
        hostHeader: hostOnly,
        tagLabel: cleanIpNodeLabel(parsed),
        ports: parsed.portOverride ? [parsed.portOverride] : allHttpPorts,
        tls: false,
      });
    }
  }

  const nodes = [];
  let idx = 1;

  outer: for (const loc of locations) {
    const locWsPath = `${cleanWsPath}${locSuffix(loc.index)}`;
    const fullWsPath = `${locWsPath}${wsPath.includes('?') ? wsPath.slice(wsPath.indexOf('?')) : ''}`;
    const locFlag = flagLabel(loc.country);

    for (const t of targets) {
      for (const port of t.ports) {
        // Uniform watermark remark: brand + protocol (+ location flag when set)
        if (protoFlags.vless) {
          const name = locFlag ? `${PANEL_BRAND} | VLESS ${locFlag}` : `${PANEL_BRAND} | VLESS`;
          nodes.push({
            index: idx++,
            name,
            protocol: 'vless',
            address: t.address,
            port,
            tls: t.tls,
            sni: t.sni,
            hostHeader: t.hostHeader,
            wsPath: fullWsPath,
            cleanWsPath: locWsPath,
            locIndex: loc.index,
            earlyData: Number(settings.earlyData) || 0,
            fingerprint: dpi.fingerprint,
            fragPackets: dpi.fragPackets,
            fragLength: dpi.fragLength,
            fragInterval: dpi.fragInterval,
            fragEnabled: dpi.fragEnabled,
            advancedFrag: dpi.advancedFrag,
            cipherSuites: dpi.cipherSuites,
            tlsMask: dpi.tlsMask,
            ech: dpi.ech,
            alpn: alpnList,
            uuid: user.uuid,
            uri: makeVlessUri(user.uuid, t, port, fullWsPath, settings, name, dpi),
          });
        }

        if (protoFlags.trojan && t.tls) {
          const name = locFlag ? `${PANEL_BRAND} | Trojan ${locFlag}` : `${PANEL_BRAND} | Trojan`;
          nodes.push({
            index: idx++,
            name,
            protocol: 'trojan',
            address: t.address,
            port,
            tls: true,
            sni: t.sni,
            hostHeader: t.hostHeader,
            wsPath: fullWsPath,
            cleanWsPath: locWsPath,
            locIndex: loc.index,
            earlyData: Number(settings.earlyData) || 0,
            fingerprint: dpi.fingerprint,
            fragPackets: dpi.fragPackets,
            fragLength: dpi.fragLength,
            fragInterval: dpi.fragInterval,
            fragEnabled: dpi.fragEnabled,
            advancedFrag: dpi.advancedFrag,
            cipherSuites: dpi.cipherSuites,
            tlsMask: dpi.tlsMask,
            ech: dpi.ech,
            alpn: alpnList,
            password: user.trojanPassword,
            uri: makeTrojanUri(user.trojanPassword, t, port, fullWsPath, settings, name, dpi),
          });
        }

        if (protoFlags.ss && t.tls) {
          const name = locFlag ? `${PANEL_BRAND} | SS ${locFlag}` : `${PANEL_BRAND} | SS`;
          nodes.push({
            index: idx++,
            name,
            protocol: 'ss',
            address: t.address,
            port,
            tls: true,
            sni: t.sni,
            hostHeader: t.hostHeader,
            wsPath: fullWsPath,
            cleanWsPath: locWsPath,
            locIndex: loc.index,
            earlyData: Number(settings.earlyData) || 0,
            fingerprint: dpi.fingerprint,
            alpn: alpnList,
            uuid: user.uuid,
            password: user.uuid,
            uri: makeSsUri(user.uuid, t, port, locWsPath, settings, name),
          });
        }

        if (nodes.length >= 200) break outer;
      }
    }
  }

  return nodes;
}

function formatHostForUri(addr) {
  return addr.includes(':') && !addr.startsWith('[') ? `[${addr}]` : addr;
}

/* ULTRA: advanced anti-DPI query params (fragment / fm / cs / mask / ech) — TLS links only.
   Returns RAW [key, value] pairs; URLSearchParams performs the single URL-encoding. */
function dpiQueryParams(dpi, target) {
  const params = [];
  if (!target.tls) return params;
  if (dpi.advancedFrag) {
    params.push(['fm', dpi.advancedFrag]);
  } else if (dpi.fragEnabled) {
    const packets = dpi.fragPackets === 'tlshello' ? ',tlshello' : '';
    params.push(['fragment', `${dpi.fragLength},${dpi.fragInterval}${packets}`]);
  }
  if (dpi.cipherSuites) params.push(['cs', dpi.cipherSuites]);
  if (dpi.tlsMask) params.push(['mask', dpi.tlsMask]);
  if (dpi.ech) params.push(['ech', dpi.ech.split(',')[0].trim()]);
  return params;
}

function makeVlessUri(uuid, target, port, wsPath, settings, name, dpi = null) {
  const params = new URLSearchParams({
    encryption: 'none',
    type: 'ws',
    host: target.hostHeader,
    path: wsPath,
  });
  if (target.tls) {
    params.set('security', 'tls');
    params.set('sni', target.sni);
    params.set('fp', dpi ? dpi.fingerprint : (settings.fingerprint || 'chrome'));
    if (settings.alpn) params.set('alpn', settings.alpn);
    if (dpi) {
      for (const [qk, qv] of dpiQueryParams(dpi, target)) {
        params.set(qk, qv);
      }
    }
  } else {
    params.set('security', 'none');
  }
  return `vless://${uuid}@${formatHostForUri(target.address)}:${port}?${params.toString()}#${encodeURIComponent(name)}`;
}

function makeTrojanUri(password, target, port, wsPath, settings, name, dpi = null) {
  const params = new URLSearchParams({
    security: 'tls',
    sni: target.sni,
    fp: dpi ? dpi.fingerprint : (settings.fingerprint || 'chrome'),
    type: 'ws',
    host: target.hostHeader,
    path: wsPath,
  });
  if (settings.alpn) params.set('alpn', settings.alpn);
  if (dpi) {
    for (const [qk, qv] of dpiQueryParams(dpi, target)) {
      params.set(qk, qv);
    }
  }
  return `trojan://${encodeURIComponent(password)}@${formatHostForUri(target.address)}:${port}?${params.toString()}#${encodeURIComponent(name)}`;
}

/* ULTRA: Shadowsocks URI with v2ray-plugin WebSocket transport (method: aes-256-gcm) */
function makeSsUri(password, target, port, cleanPath, settings, name) {
  const userInfo = utf8ToBase64(`aes-256-gcm:${password}`).replace(/=+$/, '');
  const pluginParts = [
    'v2ray-plugin',
    'mode=websocket',
    `host=${target.hostHeader}`,
    `path=${cleanPath}`,
  ];
  if (target.tls) pluginParts.push('tls');
  const plugin = encodeURIComponent(pluginParts.join(';'));
  return `ss://${userInfo}@${formatHostForUri(target.address)}:${port}/?plugin=${plugin}#${encodeURIComponent(name)}`;
}

export function buildUriLines(userView, settings, requestHost) {
  const lines = [];

  // Prohibition marker inside subscription lists
  lines.push(
    `vless://00000000-0000-0000-0000-000000000000@127.0.0.1:443?encryption=none&type=tcp#${encodeURIComponent(FREE_NOTICE_FA)}`
  );

  if (settings.showSubInfoNodes) {
    const used = formatBytes(userView.usedBytes);
    const total = userView.limitBytes > 0 ? formatBytes(userView.limitBytes) : '∞ نامحدود';
    const expLabel = userView.effectiveExpiresAt > 0
      ? `${userView.remainingDays} روز مانده`
      : (userView.startOnFirstUse && userView.expiryDays > 0
          ? `${userView.expiryDays} روز (شروع با اتصال اول)`
          : 'بدون انقضا');
    const info1 = `${userView.name} · مصرف: ${used} / ${total}`;
    const info2 = `اعتبار: ${expLabel}`;
    lines.push(`vless://00000000-0000-0000-0000-000000000000@127.0.0.1:443?encryption=none&type=tcp#${encodeURIComponent(info1)}`);
    lines.push(`vless://00000000-0000-0000-0000-000000000000@127.0.0.1:443?encryption=none&type=tcp#${encodeURIComponent(info2)}`);
    if ((userView.requestLimit || 0) > 0) {
      lines.push(`vless://00000000-0000-0000-0000-000000000000@127.0.0.1:443?encryption=none&type=tcp#${encodeURIComponent(`اتصال‌ها: ${userView.usedRequests || 0} / ${userView.requestLimit}`)}`);
    }
    if ((userView.ipLimit || 0) > 0) {
      lines.push(`vless://00000000-0000-0000-0000-000000000000@127.0.0.1:443?encryption=none&type=tcp#${encodeURIComponent(`دستگاه‌های فعال: ${userView.activeIpCount || 0} / ${userView.ipLimit}`)}`);
    }
  }

  const nodes = buildNodeDescriptors(userView, settings, requestHost);
  for (const n of nodes) lines.push(n.uri);
  return lines;
}

export function resolveRemoteDoHUrl(user, settings, requestHost) {
  if (settings.remoteDnsMode === 'private-doh') {
    return `https://${requestHost}/dns-query/${user.subToken}`;
  }
  if (settings.remoteDnsMode === 'google') return 'https://dns.google/dns-query';
  if (settings.remoteDnsMode === 'quad9') return 'https://dns.quad9.net/dns-query';
  return 'https://1.1.1.1/dns-query';
}

/* ------------------------------------------- Xray Full JSON (Fragment-ready) */

export function buildXrayConfigs(userView, settings, requestHost) {
  const nodes = buildNodeDescriptors(userView, settings, requestHost).filter((n) => n.tls);
  const remoteDoH = resolveRemoteDoHUrl(userView, settings, requestHost);
  const hostOnly = String(requestHost || '').split(':')[0];

  // Collect all server/clean domains that MUST resolve via direct DNS to prevent bootstrap loops
  const bootstrapDomains = new Set([`full:${hostOnly}`]);
  for (const n of nodes) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(n.address) && !n.address.includes(':')) {
      bootstrapDomains.add(`full:${n.address}`);
    }
  }

  return nodes.map((node) => {
    const useFrag = Boolean(node.fragEnabled !== undefined ? node.fragEnabled : settings.enableFragment);
    const remarks = node.name;

    const wsSettingsOut = {
      path: node.wsPath,
      headers: { Host: node.hostHeader },
    };

    const proxyOutbound = {
      tag: 'proxy',
      protocol: node.protocol === 'ss' ? 'shadowsocks' : node.protocol,
      settings: node.protocol === 'vless'
        ? {
            vnext: [
              {
                address: node.address,
                port: node.port,
                users: [{ id: node.uuid, encryption: 'none' }],
              },
            ],
          }
        : node.protocol === 'ss'
          ? {
              servers: [
                {
                  address: node.address,
                  port: node.port,
                  method: 'aes-256-gcm',
                  password: node.password,
                },
              ],
            }
          : {
              servers: [
                {
                  address: node.address,
                  port: node.port,
                  password: node.password,
                },
              ],
            },
      streamSettings: {
        network: 'ws',
        security: 'tls',
        tlsSettings: {
          serverName: node.sni,
          alpn: node.alpn,
          fingerprint: node.fingerprint,
          allowInsecure: false,
        },
        wsSettings: wsSettingsOut,
        sockopt: {
          tcpKeepAliveIdle: 100,
          tcpNoDelay: true,
          ...(useFrag ? { dialerProxy: 'fragment' } : {}),
        },
      },
    };

    const outbounds = [proxyOutbound];

    if (useFrag) {
      const fragSettings = {
        domainStrategy: 'AsIs',
        fragment: {
          packets: node.fragPackets || settings.fragmentPackets || '1-1',
          length: node.fragLength || settings.fragmentLength || '10-20',
          interval: node.fragInterval || settings.fragmentInterval || '10-20',
        },
      };
      if (settings.enableNoise) {
        fragSettings.noises = [
          { type: 'rand', packet: '10-20', delay: '10-16' },
        ];
      }
      outbounds.push({
        tag: 'fragment',
        protocol: 'freedom',
        settings: fragSettings,
        streamSettings: {
          sockopt: { tcpKeepAliveIdle: 100, tcpNoDelay: true },
        },
      });
    }

    outbounds.push(
      { tag: 'direct', protocol: 'freedom', settings: { domainStrategy: 'UseIP' } },
      { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'none' } } }
    );

    // IMPORTANT: Keep bootstrapDomains strictly in `dns.servers[1].domains` so Xray resolves
    // clean addresses (e.g. www.speedtest.net) without routing browser traffic over DIRECT!
    const directDomains = [];
    if (settings.bypassIran) directDomains.push('geosite:ir', 'regexp:.*\\.ir$');
    if (settings.bypassChina) directDomains.push('geosite:cn');
    if (settings.bypassRussia) directDomains.push('geosite:ru');
    for (const d of settings.customDirectDomains || []) directDomains.push(d);

    const rules = [];
    if (settings.blockQuic) {
      rules.push({ type: 'field', network: 'udp', port: '443', outboundTag: 'block' });
    }
    const blockedDomains = [];
    if (settings.blockAds) blockedDomains.push('geosite:category-ads-all');
    if (settings.blockAdult) blockedDomains.push('geosite:category-porn');
    for (const d of settings.customBlockDomains || []) blockedDomains.push(d);
    if (blockedDomains.length) {
      rules.push({ type: 'field', domain: blockedDomains, outboundTag: 'block' });
    }

    if (settings.sanctionBypass && settings.customProxyDomains?.length) {
      rules.push({
        type: 'field',
        domain: settings.customProxyDomains,
        outboundTag: 'proxy',
      });
    }

    if (settings.bypassLAN) {
      rules.push({ type: 'field', ip: ['geoip:private'], outboundTag: 'direct' });
    }
    const directIps = [];
    if (settings.bypassIran) directIps.push('geoip:ir');
    if (settings.bypassChina) directIps.push('geoip:cn');
    if (settings.bypassRussia) directIps.push('geoip:ru');
    if (directDomains.length) {
      rules.push({ type: 'field', domain: directDomains, outboundTag: 'direct' });
    }
    if (directIps.length) {
      rules.push({ type: 'field', ip: directIps, outboundTag: 'direct' });
    }

    return {
      remarks,
      log: { loglevel: 'warning' },
      dns: {
        servers: [
          remoteDoH,
          {
            address: settings.directDns || '8.8.8.8',
            port: 53,
            domains: [...bootstrapDomains, ...directDomains],
          },
        ],
        queryStrategy: 'UseIP',
      },
      inbounds: [
        {
          tag: 'socks-in',
          port: 10808,
          listen: '127.0.0.1',
          protocol: 'socks',
          sniffing: { enabled: true, destOverride: ['http', 'tls'], routeOnly: false },
          settings: { auth: 'noauth', udp: true },
        },
        {
          tag: 'http-in',
          port: 10809,
          listen: '127.0.0.1',
          protocol: 'http',
          sniffing: { enabled: true, destOverride: ['http', 'tls'], routeOnly: false },
        },
      ],
      outbounds,
      routing: {
        domainStrategy: 'IPIfNonMatch',
        rules,
      },
    };
  });
}

/* ------------------------------------------- Sing-box / Hiddify JSON Config */

export function buildSingboxConfig(userView, settings, requestHost) {
  const nodes = buildNodeDescriptors(userView, settings, requestHost);
  const remoteDoH = resolveRemoteDoHUrl(userView, settings, requestHost);

  const nodeTags = [];
  // Sing-box requires unique outbound tags; keep the clean watermark and add the minimal
  // numeric suffix ONLY when the same remark repeats (structural need, not extra metadata).
  const tagSeq = new Map();
  const uniqueTag = (base) => {
    const k = (tagSeq.get(base) || 0) + 1;
    tagSeq.set(base, k);
    return k === 1 ? base : `${base} · ${k}`;
  };
  const nodeOutbounds = nodes.map((n) => {
    const tag = uniqueTag(n.name);
    nodeTags.push(tag);
    const out = {
      type: n.protocol === 'ss' ? 'shadowsocks' : n.protocol,
      tag,
      server: n.address,
      server_port: n.port,
      transport: {
        type: 'ws',
        path: n.cleanWsPath,
        headers: { Host: n.hostHeader },
        ...(n.earlyData > 0
          ? { max_early_data: n.earlyData, early_data_header_name: 'Sec-WebSocket-Protocol' }
          : {}),
      },
    };
    if (n.protocol === 'vless') out.uuid = n.uuid;
    else if (n.protocol === 'ss') {
      out.method = 'aes-256-gcm';
      out.password = n.password;
      out.plugin = 'v2ray-plugin';
      out.plugin_opts = {
        mode: 'websocket',
        ...(n.tls ? { tls: true } : {}),
        host: n.hostHeader,
        path: n.cleanWsPath,
        ...(n.earlyData > 0 ? { max_early_data: n.earlyData, early_data_header_name: 'Sec-WebSocket-Protocol' } : {}),
      };
      return out;
    } else out.password = n.password;

    if (n.tls) {
      out.tls = {
        enabled: true,
        server_name: n.sni,
        alpn: n.alpn,
        utls: { enabled: true, fingerprint: n.fingerprint },
        ...(n.fragEnabled !== undefined ? (n.fragEnabled ? { record_fragment: true } : {}) : (settings.enableFragment ? { record_fragment: true } : {})),
      };
    }
    return out;
  });

  const directSuffixes = [];
  if (settings.bypassIran) directSuffixes.push('.ir', '.ایران');
  if (settings.bypassChina) directSuffixes.push('.cn');
  if (settings.bypassRussia) directSuffixes.push('.ru');
  for (const d of settings.customDirectDomains || []) {
    directSuffixes.push(d.replace(/^domain:/, '.'));
  }

  const routeRules = [
    { protocol: 'dns', outbound: 'dns-out' },
  ];
  if (settings.bypassLAN) {
    routeRules.push({ ip_is_private: true, outbound: 'direct' });
  }
  if (settings.blockQuic) {
    routeRules.push({ network: 'udp', port: 443, outbound: 'block' });
  }
  if (settings.customBlockDomains?.length) {
    routeRules.push({ domain_suffix: settings.customBlockDomains, outbound: 'block' });
  }
  if (settings.sanctionBypass && settings.customProxyDomains?.length) {
    routeRules.push({ domain_suffix: settings.customProxyDomains, outbound: 'Aral' });
  }
  if (directSuffixes.length) {
    routeRules.push({ domain_suffix: directSuffixes, outbound: 'direct' });
  }

  return {
    log: { level: 'warn', timestamp: true },
    dns: {
      servers: [
        {
          tag: 'dns-remote',
          address: remoteDoH,
          address_resolver: 'dns-direct',
          detour: 'Aral',
        },
        {
          tag: 'dns-direct',
          address: settings.directDns || '8.8.8.8',
          detour: 'direct',
        },
      ],
      rules: [
        { outbound: 'any', server: 'dns-direct' },
        ...(directSuffixes.length ? [{ domain_suffix: directSuffixes, server: 'dns-direct' }] : []),
      ],
      final: 'dns-remote',
    },
    inbounds: [
      {
        type: 'mixed',
        tag: 'mixed-in',
        listen: '127.0.0.1',
        listen_port: 10808,
        sniff: true,
      },
    ],
    outbounds: [
      {
        type: 'selector',
        tag: 'Aral',
        outbounds: ['Auto Best', ...nodeTags, 'direct'],
        default: 'Auto Best',
      },
      {
        type: 'urltest',
        tag: 'Auto Best',
        outbounds: nodeTags,
        url: 'https://www.gstatic.com/generate_204',
        interval: '3m',
        tolerance: 80,
      },
      ...nodeOutbounds,
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'block' },
      { type: 'dns', tag: 'dns-out' },
    ],
    route: {
      auto_detect_interface: true,
      rules: routeRules,
      final: 'Aral',
    },
  };
}

/* ------------------------------------------- Clash Meta / Mihomo YAML Config */

export function buildClashYaml(userView, settings, requestHost) {
  const nodes = buildNodeDescriptors(userView, settings, requestHost);
  const proxyLines = [];
  const names = [];
  // Clash/Mihomo requires unique proxy names; minimal numeric suffix only on repeats.
  const nameSeq = new Map();
  const uniqueName = (base) => {
    const k = (nameSeq.get(base) || 0) + 1;
    nameSeq.set(base, k);
    return k === 1 ? base : `${base} · ${k}`;
  };

  for (const n of nodes) {
    const safeName = uniqueName(n.name.replace(/"/g, "'"));
    names.push(`      - "${safeName}"`);
    if (n.protocol === 'vless') {
      proxyLines.push(
        `  - name: "${safeName}"`,
        `    type: vless`,
        `    server: ${n.address}`,
        `    port: ${n.port}`,
        `    uuid: ${n.uuid}`,
        `    udp: true`,
        `    tls: ${n.tls ? 'true' : 'false'}`,
        ...(n.tls
          ? [
              `    servername: ${n.sni}`,
              `    client-fingerprint: ${n.fingerprint}`,
              `    alpn: [${n.alpn.map((a) => `"${a}"`).join(', ')}]`,
            ]
          : []),
        `    network: ws`,
        `    ws-opts:`,
        `      path: "${n.cleanWsPath}"`,
        `      headers:`,
        `        Host: ${n.hostHeader}`,
        ...(n.earlyData > 0
          ? [
              `      max-early-data: ${n.earlyData}`,
              `      early-data-header-name: Sec-WebSocket-Protocol`,
            ]
          : [])
      );
    } else if (n.protocol === 'ss') {
      proxyLines.push(
        `  - name: "${safeName}"`,
        `    type: ss`,
        `    server: ${n.address}`,
        `    port: ${n.port}`,
        `    cipher: aes-256-gcm`,
        `    password: "${String(n.password).replace(/"/g, '\\"')}"`,
        `    udp: true`,
        `    plugin: v2ray-plugin`,
        `    plugin-opts:`,
        `      mode: websocket`,
        `      host: ${n.hostHeader}`,
        `      path: "${n.cleanWsPath}"`,
        `      tls: ${n.tls ? 'true' : 'false'}`,
        ...(n.earlyData > 0 ? [`      max-early-data: ${n.earlyData}`, `      early-data-header-name: Sec-WebSocket-Protocol`] : [])
      );
    } else {
      proxyLines.push(
        `  - name: "${safeName}"`,
        `    type: trojan`,
        `    server: ${n.address}`,
        `    port: ${n.port}`,
        `    password: "${n.password.replace(/"/g, '\\"')}"`,
        `    udp: true`,
        `    sni: ${n.sni}`,
        `    client-fingerprint: ${n.fingerprint}`,
        `    alpn: [${n.alpn.map((a) => `"${a}"`).join(', ')}]`,
        `    network: ws`,
        `    ws-opts:`,
        `      path: "${n.cleanWsPath}"`,
        `      headers:`,
        `        Host: ${n.hostHeader}`,
        ...(n.earlyData > 0
          ? [
              `      max-early-data: ${n.earlyData}`,
              `      early-data-header-name: Sec-WebSocket-Protocol`,
            ]
          : [])
      );
    }
  }

  const rules = [];
  if (settings.bypassLAN) rules.push('  - GEOIP,PRIVATE,DIRECT,no-resolve');
  if (settings.blockQuic) rules.push('  - AND,((NETWORK,UDP),(DST-PORT,443)),REJECT');
  for (const d of settings.customBlockDomains || []) {
    rules.push(`  - DOMAIN-SUFFIX,${d.replace(/^\./, '')},REJECT`);
  }
  if (settings.sanctionBypass) {
    for (const d of settings.customProxyDomains || []) {
      rules.push(`  - DOMAIN-SUFFIX,${d.replace(/^\./, '')},Aral`);
    }
  }
  for (const d of settings.customDirectDomains || []) {
    rules.push(`  - DOMAIN-SUFFIX,${d.replace(/^\./, '')},DIRECT`);
  }
  if (settings.bypassIran) {
    rules.push('  - DOMAIN-SUFFIX,ir,DIRECT');
    rules.push('  - GEOIP,IR,DIRECT,no-resolve');
  }
  if (settings.bypassChina) rules.push('  - GEOIP,CN,DIRECT,no-resolve');
  if (settings.bypassRussia) rules.push('  - GEOIP,RU,DIRECT,no-resolve');
  rules.push('  - MATCH,Aral');

  return [
    'mixed-port: 7890',
    'allow-lan: false',
    'mode: rule',
    'log-level: warning',
    'ipv6: true',
    'unified-delay: true',
    'tcp-concurrent: true',
    `global-client-fingerprint: ${settings.fingerprint || 'chrome'}`,
    'dns:',
    '  enable: true',
    '  ipv6: true',
    '  enhanced-mode: fake-ip',
    '  fake-ip-range: 198.18.0.1/16',
    '  default-nameserver:',
    `    - ${settings.directDns || '8.8.8.8'}`,
    '    - 1.1.1.1',
    '  nameserver:',
    '    - https://1.1.1.1/dns-query',
    '    - https://dns.google/dns-query',
    'proxies:',
    ...proxyLines,
    'proxy-groups:',
    '  - name: "Aral"',
    '    type: select',
    '    proxies:',
    '      - "Auto Best"',
    ...names,
    '      - DIRECT',
    '  - name: "Auto Best"',
    '    type: url-test',
    '    url: https://www.gstatic.com/generate_204',
    '    interval: 180',
    '    tolerance: 80',
    '    proxies:',
    ...names,
    'rules:',
    ...rules,
    '',
  ].join('\n');
}

/* ------------------------------------------- Subscription HTTP Dispatcher */

export function buildSubscriptionHeaders(userView, settings, requestHost) {
  const titleB64 = utf8ToBase64(`${PANEL_BRAND} · ${userView.name}`);
  const announceB64 = utf8ToBase64(FREE_NOTICE_FULL);
  const expSec = userView.effectiveExpiresAt > 0 ? Math.floor(userView.effectiveExpiresAt / 1000) : 0;
  return {
    'cache-control': 'no-store, no-cache, must-revalidate',
    'profile-title': `base64:${titleB64}`,
    'announce': `base64:${announceB64}`,
    'profile-update-interval': String(settings.subUpdateHours || 6),
    'subscription-userinfo': `upload=${userView.usedUpBytes}; download=${userView.usedDownBytes}; total=${userView.limitBytes}; expire=${expSec}`,
    'profile-web-page-url': `https://${requestHost}/sub/${encodeURIComponent(userView.subToken)}`,
    'access-control-allow-origin': '*',
  };
}

export function detectSubscriptionFormat(request) {
  const url = new URL(request.url);
  const explicit = (url.searchParams.get('format') || url.searchParams.get('target') || '').toLowerCase();
  if (explicit) {
    if (['xray', 'fragment', 'frag'].includes(explicit)) return 'xray';
    if (['singbox', 'sing-box', 'sfa', 'hiddify'].includes(explicit)) return 'singbox';
    if (['clash', 'mihomo', 'yaml'].includes(explicit)) return 'clash';
    if (['raw', 'txt', 'plain', 'v2ray'].includes(explicit)) return 'raw';
    if (['b64', 'base64'].includes(explicit)) return 'b64';
    if (explicit === 'json') return 'json';
  }

  const ua = (request.headers.get('user-agent') || '').toLowerCase();
  const accept = (request.headers.get('accept') || '').toLowerCase();

  // Known VPN client user-agents take priority over Accept
  if (/clash|mihomo|flclash|verge|stash/.test(ua)) return 'clash';
  if (/sing-box|sfa|sfi|sft|hiddify/.test(ua)) return 'singbox';
  if (/v2ray|mahsa|streisand|nekobox|nekoray|shadowrocket|v2box|foxray|happ/.test(ua)) return 'b64';

  if (accept.includes('text/html') && /mozilla|chrome|safari|firefox|edg/i.test(ua)) {
    return 'html';
  }
  if (accept.includes('application/json')) return 'json';
  return 'b64';
}

export async function serveSubscription(request, user, settings = {}, assets = {}, env = null) {
  try {
    const url = new URL(request.url);
    const requestHost = url.host || 'localhost';
    const safeSettings = settings && typeof settings === 'object' ? settings : {};
    const hydrated = await hydrateUserAddresses(env, enrichUserView(user), safeSettings);
    const userView = hydrated;
    const headers = buildSubscriptionHeaders(userView, safeSettings, requestHost);
    const fmt = detectSubscriptionFormat(request);

    if (fmt === 'html') {
      const html = await renderSubscriberPressPass(userView, safeSettings, requestHost, assets);
      return new Response(html, {
        status: 200,
        headers: {
          ...headers,
          'content-type': 'text/html; charset=utf-8',
        },
      });
    }

    if (userView.status !== 'active') {
      const reasonMap = {
        paused: 'اشتراک موقتاً غیرفعال شده است (Paused)',
        expired: 'مهلت زمانی اشتراک به پایان رسیده است (Expired)',
        quota: 'حجم اشتراک به پایان رسیده است (Quota Reached)',
        reqquota: 'سهمیهٔ تعداد اتصال به پایان رسیده است (Request Quota)',
      };
      const msg = `[!] ${userView.name}: ${reasonMap[userView.status] || 'غیرفعال'}`;
      const deadUri = `vless://00000000-0000-0000-0000-000000000000@127.0.0.1:443?encryption=none&type=tcp#${encodeURIComponent(msg)}`;
      if (fmt === 'raw') {
        return new Response(deadUri + '\n', { headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } });
      }
      return new Response(utf8ToBase64(deadUri + '\n'), {
        headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    if (fmt === 'xray') {
      const body = JSON.stringify(buildXrayConfigs(userView, safeSettings, requestHost), null, 2);
      return new Response(body, {
        headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
      });
    }

    if (fmt === 'singbox') {
      const body = JSON.stringify(buildSingboxConfig(userView, safeSettings, requestHost), null, 2);
      return new Response(body, {
        headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
      });
    }

    if (fmt === 'clash') {
      const body = buildClashYaml(userView, safeSettings, requestHost);
      return new Response(body, {
        headers: { ...headers, 'content-type': 'text/yaml; charset=utf-8' },
      });
    }

    const lines = buildUriLines(userView, safeSettings, requestHost);

    if (fmt === 'json') {
      const nodes = buildNodeDescriptors(userView, safeSettings, requestHost);
      return new Response(
        JSON.stringify(
          {
            name: `${PANEL_BRAND} · ${userView.name}`,
            status: userView.status,
            vless: nodes.find((n) => n.protocol === 'vless')?.uri || null,
            trojan: nodes.find((n) => n.protocol === 'trojan')?.uri || null,
            ss: nodes.find((n) => n.protocol === 'ss')?.uri || null,
            nodes,
            clash: buildClashYaml(userView, safeSettings, requestHost),
            singbox: buildSingboxConfig(userView, safeSettings, requestHost),
            xray: buildXrayConfigs(userView, safeSettings, requestHost),
          },
          null,
          2
        ),
        { headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } }
      );
    }

    if (fmt === 'raw') {
      return new Response(lines.join('\n') + '\n', {
        headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    return new Response(utf8ToBase64(lines.join('\n')), {
      headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' },
    });
  } catch (err) {
    return new Response(`Subscription generation error: ${err?.message || 'unknown'}`, {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}

/* ------------------------------- Bilingual Newsprint Subscriber Press Pass */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function renderSubscriberPressPass(userView, settings, requestHost, assets = {}) {
  const nodes = buildNodeDescriptors(userView, settings, requestHost);
  const baseSub = `https://${requestHost}/sub/${encodeURIComponent(userView.subToken)}`;
  const dohUrl = `https://${requestHost}/dns-query/${encodeURIComponent(userView.subToken)}`;
  const usedStr = formatBytes(userView.usedBytes);
  const limitStr = userView.limitBytes > 0 ? formatBytes(userView.limitBytes) : '∞';
  const rawUsed = Math.max(0, Number(userView.usedBytes) || 0);
  const pct =
    rawUsed <= 0
      ? 0
      : userView.limitBytes > 0
        ? Math.min(100, Math.max(1, Math.round((rawUsed / userView.limitBytes) * 100)))
        : Math.min(100, Math.max(1, Math.round((rawUsed / (50 * 1073741824)) * 100)));

  const statusFaMap = { active: 'فعال · خط باز', paused: 'متوقف', expired: 'منقضی‌شده', quota: 'اتمام حجم', reqquota: 'اتمام سهمیهٔ اتصال' };
  const statusEnMap = { active: 'ACTIVE · WIRE OPEN', paused: 'PAUSED', expired: 'EXPIRED', quota: 'QUOTA FULL', reqquota: 'REQ QUOTA FULL' };

  const expPct = userView.effectiveExpiresAt > 0 && userView.expiryDays > 0
    ? Math.min(100, Math.max(0, Math.round(100 - (userView.remainingDays / userView.expiryDays) * 100)))
    : (userView.effectiveExpiresAt > 0 ? Math.min(100, Math.max(1, 100 - Math.round((userView.remainingDays / 30) * 100))) : 0);
  const reqPct = (userView.requestLimit || 0) > 0
    ? Math.min(100, Math.round(((userView.usedRequests || 0) / userView.requestLimit) * 100))
    : 0;
  const ipPct = (userView.ipLimit || 0) > 0
    ? Math.min(100, Math.round(((userView.activeIpCount || 0) / userView.ipLimit) * 100))
    : 0;
  const isOnline = (userView.lastSeenAt || 0) > 0 && Date.now() - userView.lastSeenAt < 120_000;

  const expFa = userView.effectiveExpiresAt > 0
    ? `${userView.remainingDays} روز باقی‌مانده`
    : (userView.startOnFirstUse && userView.expiryDays > 0
        ? `${userView.expiryDays} روز (شروع با اولین اتصال)`
        : 'نامحدود');
  const expEn = userView.effectiveExpiresAt > 0
    ? `${userView.remainingDays} days left`
    : (userView.startOnFirstUse && userView.expiryDays > 0
        ? `${userView.expiryDays}d (starts on first connect)`
        : 'No expiry');

  const tgInfo =
    settings.enableTgProxy !== false && settings.tgProxySecret
      ? await buildTgProxyFullLinks(requestHost, settings.tgProxySecret, settings.tgProxyDomain)
      : { tgUrl: '', tmeUrl: '', ports: [] };

  const payload = JSON.stringify({
    baseSub,
    fragSub: `${baseSub}?format=xray`,
    sbSub: `${baseSub}?format=singbox`,
    clashSub: `${baseSub}?format=clash`,
    dohUrl,
    tgUrl: tgInfo.tgUrl,
    tmeUrl: tgInfo.tmeUrl,
    nodes: nodes.map((n) => ({ name: n.name, protocol: n.protocol.toUpperCase(), port: n.port, uri: n.uri })),
  }).replace(/</g, '\\u003c');

  const svgSend = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 2L11 13"/><path d="M22 2L15 22l-4-9-9-4 20-7z"/></svg>';
  const svgShield = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>';
  const svgSun = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
  const svgMoon = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  const svgGauge = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 13l3.5-3.5"/><circle cx="12" cy="13" r="1.4"/></svg>';
  const svgCopy = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="1"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';
  const svgQr = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM18 18h3v3h-3zM18 14h3M14 18v3"/></svg>';
  const svgServer = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="3" width="20" height="7" rx="1"/><rect x="2" y="14" width="20" height="7" rx="1"/><path d="M6 6.5h.01M6 17.5h.01"/></svg>';
  const svgBolt = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>';

  const tgPortCards = (tgInfo.ports || [])
    .map(
      (p) => `
        <div class="tg-port${p.port === 443 ? ' default' : ''}">
          <div class="tg-port-head">
            <span class="tg-port-num">:${esc(String(p.port))}</span>
            <span class="tg-port-tag badge inv">${p.port === 443 ? 'پیش‌فرض' : 'HTTPS'}</span>
          </div>
          <a class="tg-connect" href="${esc(p.tgUrl)}">${svgSend}<span class="fa">اتصال در تلگرام</span><span class="en">CONNECT</span></a>
          <div class="tg-mini-row">
            <button class="tg-mini cp" type="button" data-val="${esc(p.tmeUrl)}"><svg class="ic" viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="1"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>t.me</button>
            <button class="tg-mini qr-pick" type="button" data-q="${esc(p.tmeUrl)}" data-l="Telegram :${esc(String(p.port))}"><svg class="ic" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM18 18h3v3h-3zM18 14h3M14 18v3"/></svg>QR</button>
          </div>
          <div class="tg-secret cp" data-val="${esc(p.secret)}">${esc(p.secret)}</div>
        </div>`
    )
    .join('');

  const tgHtmlBlock = tgInfo.tgUrl
    ? `
      <p class="kicker" style="margin-top:20px"><span class="fa">پروکسیِ تلگرام — همهٔ پورت‌ها</span><span class="en">TELEGRAM WEB PROXY — ALL PORTS</span></p>
      <div class="tg-grid" style="margin-top:8px">${tgPortCards}</div>`
    : '';

  return `<!doctype html>
<html lang="fa" dir="rtl" data-lang="fa" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="dark light">
<title>${PANEL_BRAND} — کارتِ مشترک · ${esc(userView.name)}</title>
<style>${assets.style || ''}</style>
</head>
<body>
<div class="bg-checker" aria-hidden="true"></div>
<div class="bg-grid" aria-hidden="true"></div>
<div class="bg-scan" aria-hidden="true"></div>
<div class="bg-beam" style="top:-70vmax;left:-20vmax" aria-hidden="true"></div>
<div class="modal-backdrop" id="sub-free-modal" hidden>
  <div class="modal-box" role="dialog" aria-modal="true">
    <p class="kicker">${svgShield} <span class="fa">آرال سولفور</span><span class="en">ARAL SULFUR</span></p>
    <h3 class="head" style="margin-top:4px">
      <span class="fa">کپی‌برداری و فروش ممنوع است</span>
      <span class="en">Copying &amp; Selling Is Prohibited</span>
    </h3>
    <p class="hint" style="margin-top:10px;font-size:13px">
      <span class="fa">این پروژه متعلق به <b>ARAL</b> است. هرگونه کپی‌برداری، بازفروش یا انتشار تجاری آن ممنوع است.</span>
      <span class="en">This project belongs to <b>ARAL</b>. Copying, reselling or commercial redistribution is prohibited.</span>
    </p>
    <div class="actions" style="margin-top:16px;justify-content:flex-end">
      <button class="btn" id="sub-free-ok" type="button"><span class="fa">متوجه شدم</span><span class="en">I UNDERSTAND</span></button>
    </div>
  </div>
</div>
<div class="shell">
  <header class="topbar">
    <div class="logo"><span class="logo-mark" role="img" aria-label="Aral Sulfur"></span><span class="logo-word">Aral<small>SULFUR</small></span></div>
    <div class="top-mid"><span class="top-tag">SUBSCRIBER&nbsp;ACCESS&nbsp;PASS&nbsp;·&nbsp;V${PANEL_VERSION}</span></div>
    <div class="top-acts">
      <button class="sw" id="s-free-btn" type="button">${svgShield}<span class="fa">کپی‌برداری و فروش ممنوع</span><span class="en">NOT FOR RESALE</span></button>
      <button class="sw" id="s-lang" type="button">EN</button>
      <div class="theme-grp">
        <button class="sw st-pick" data-th="light" type="button" title="روشن">${svgSun}</button>
        <button class="sw st-pick" data-th="dark" type="button" title="دارک">${svgMoon}</button>
      </div>
    </div>
  </header>

  <section class="hero">
    <h1 class="wordmark" style="font-size:clamp(24px,4.4vw,36px)">ARAL <b>SULFUR</b></h1>
    <p class="hero-sub">
      <span class="fa">کارتِ عبورِ مشترک: <b>${esc(userView.name)}</b></span>
      <span class="en">SUBSCRIBER ACCESS PASS: <b>${esc(userView.name)}</b></span>
    </p>
    <span class="hero-pill">${esc(statusEnMap[userView.status] || 'ACTIVE')}</span>
  </section>

  <div class="notice-strip">
    ${svgShield}
    <span class="fa"><b>کپی‌برداری و فروش ممنوع است</b> — پروژهٔ ARAL</span>
    <span class="en"><b>COPYING &amp; SELLING PROHIBITED</b> — ARAL Project</span>
  </div>

  <div class="cols" style="margin-top:16px">
    <section class="card">
      <p class="kicker">${svgGauge} <span class="fa">وضعیتِ خطِ اختصاصی</span><span class="en">ACCOUNT LEDGER</span></p>
      <div class="stat-strip">
        <span class="badge ${userView.status === 'active' ? 'ok' : 'bad'}">
          <span class="fa">${esc(statusFaMap[userView.status])}</span>
          <span class="en">${esc(statusEnMap[userView.status])}</span>
        </span>
        <span class="mono sm">CONNECTIONS: ${userView.connections || 0}</span>
      </div>

      <table class="specs" style="margin-top:12px">
        <tbody>
          <tr><th><span class="fa">مشترک</span><span class="en">HOLDER</span></th><td>${esc(userView.name)}</td></tr>
          <tr><th><span class="fa">مصرفِ ترافیک</span><span class="en">TRAFFIC</span></th><td class="mono">${esc(usedStr)} / ${esc(limitStr)}</td></tr>
          <tr><th><span class="fa">اعتبارِ زمانی</span><span class="en">VALIDITY</span></th><td><span class="fa">${esc(expFa)}</span><span class="en">${esc(expEn)}</span></td></tr>
          ${(userView.requestLimit || 0) > 0 ? `<tr><th><span class="fa">سهمیهٔ اتصال</span><span class="en">REQUESTS</span></th><td class="mono">${userView.usedRequests || 0} / ${userView.requestLimit}</td></tr>` : ''}
          ${(userView.ipLimit || 0) > 0 ? `<tr><th><span class="fa">دستگاه‌های همزمان</span><span class="en">DEVICES</span></th><td class="mono">${userView.activeIpCount || 0} / ${userView.ipLimit}</td></tr>` : ''}
          <tr><th><span class="fa">تعدادِ نودها</span><span class="en">NODES</span></th><td class="mono">${nodes.length}</td></tr>
          <tr><th><span class="fa">وضعیت زنده</span><span class="en">LIVE</span></th><td>${isOnline ? '<span class="badge ok"><span class="fa">آنلاین</span><span class="en">ONLINE</span></span>' : '<span class="badge"><span class="fa">آفلاین</span><span class="en">OFFLINE</span></span>'}</td></tr>
        </tbody>
      </table>
      <div class="meter" style="margin-top:12px"><i style="width:${pct}%"></i></div>
      ${expPct > 0 ? `<div class="meter dim" style="margin-top:6px"><i style="width:${expPct}%"></i></div>` : ''}
      ${reqPct > 0 ? `<div class="meter dim" style="margin-top:6px"><i style="width:${reqPct}%"></i></div>` : ''}
      ${ipPct > 0 ? `<div class="meter dim" style="margin-top:6px"><i style="width:${ipPct}%"></i></div>` : ''}

      <p class="kicker" style="margin-top:22px">${svgCopy} <span class="fa">لینک‌های اشتراکِ هوشمند</span><span class="en">SUBSCRIPTION LINKS</span></p>
      <div class="sub-grid">
        <button class="btn sm-btn cp" data-val="${esc(baseSub)}"><span class="fa">کپی اشتراک عمومی (Base64)</span><span class="en">COPY NORMAL SUB</span></button>
        <button class="btn ghost sm-btn cp" data-val="${esc(baseSub + '?format=xray')}"><span class="fa">کپی اشتراک Fragment (ضد فیلتر)</span><span class="en">COPY XRAY FRAGMENT</span></button>
        <button class="btn ghost sm-btn cp" data-val="${esc(baseSub + '?format=singbox')}"><span class="fa">کپی Sing-box / Hiddify</span><span class="en">COPY SING-BOX</span></button>
        <button class="btn ghost sm-btn cp" data-val="${esc(baseSub + '?format=clash')}"><span class="fa">کپی Clash / Mihomo</span><span class="en">COPY CLASH YAML</span></button>
        <button class="btn ghost sm-btn cp" data-val="${esc(dohUrl)}"><span class="fa">کپی DoH اختصاصی</span><span class="en">COPY PRIVATE DoH</span></button>
      </div>
      ${tgHtmlBlock}

      <p class="kicker" style="margin-top:20px">${svgBolt} <span class="fa">ورودِ یک‌ضرب به برنامه</span><span class="en">ONE-TAP CLIENT IMPORT</span></p>
      <div class="actions" style="margin-top:8px">
        <a class="btn ghost sm-btn" href="v2rayng://install-config?url=${encodeURIComponent(baseSub)}">v2rayNG</a>
        <a class="btn ghost sm-btn" href="v2rayng://install-config?url=${encodeURIComponent(baseSub + '?format=xray')}">v2rayNG (Frag)</a>
        <a class="btn ghost sm-btn" href="hiddify://import/${encodeURIComponent(baseSub + '?format=singbox')}#Aral">Hiddify</a>
        <a class="btn ghost sm-btn" href="sing-box://import-remote-profile?url=${encodeURIComponent(baseSub + '?format=singbox')}#Aral">Sing-box</a>
        <a class="btn ghost sm-btn" href="streisand://import/${encodeURIComponent(baseSub)}">Streisand</a>
        <a class="btn ghost sm-btn" href="clash://install-config?url=${encodeURIComponent(baseSub + '?format=clash')}&name=Aral">Clash</a>
      </div>
    </section>

    <section class="card">
      <p class="kicker">${svgQr} <span class="fa">کدِ مربعی (QR)</span><span class="en">ACCESS QR</span></p>
      <div class="qr-center">
        <div class="qrbox"><div class="qr" id="s-qr"></div></div>
        <p class="mono sm" id="s-qr-label" style="margin:10px 0 0;word-break:break-all">SUBSCRIPTION URL</p>
      </div>
      <div class="actions" style="justify-content:center;margin-top:12px">
        <button class="btn ghost sm-btn qr-pick" data-q="${esc(baseSub)}" data-l="Normal Sub">Normal QR</button>
        <button class="btn ghost sm-btn qr-pick" data-q="${esc(baseSub + '?format=xray')}" data-l="Fragment Sub">Fragment QR</button>
      </div>
    </section>
  </div>

  <figure class="scene-figure">
    ${assets.skyline || ''}
    <figcaption class="scene-caption">
      <span class="fa">قلهٔ آرال در شبِ گوگردی — برفِ درخشان و بادِ قله را با موس تکان بده</span>
      <span class="en">THE ARAL SUMMIT · SULFUR NIGHT — move your pointer &amp; click the peak</span>
    </figcaption>
  </figure>

  <section class="card" style="margin-top:16px">
    <p class="kicker">${svgServer} <span class="fa">فهرستِ تکیِ نودها (${nodes.length})</span><span class="en">INDIVIDUAL WIRE NODES (${nodes.length})</span></p>
    <div class="node-list" id="s-nodes"></div>
  </section>

  <footer class="foot">
    <span class="dot" aria-hidden="true"></span>
    <span>ARAL SULFUR V${PANEL_VERSION}</span>
    <span class="dot" aria-hidden="true"></span>
    <a class="inline-link" href="https://t.me/AralDev" target="_blank" rel="noopener">t.me/AralDev</a>
    <span class="dot" aria-hidden="true"></span>
    <span class="no-resale">COPYING &amp; SELLING PROHIBITED</span>
    <span class="dot" aria-hidden="true"></span>
  </footer>
</div>
<script>window.SUB_DATA=${payload};</script>
<script>${assets.qr || ''}</script>
<script>${assets.mtn || ''}</script>
<script>
(function(){
  window.addEventListener('unhandledrejection', function(ev){ ev.preventDefault(); });
  var html=document.documentElement, D=window.SUB_DATA||{};
  function lsGet(k,fb){ try{ return localStorage.getItem(k)||fb; }catch(e){ return fb; } }
  function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
  function safeCopy(txt){
    var str=String(txt||'');
    try{
      if(navigator.clipboard&&navigator.clipboard.writeText){
        return navigator.clipboard.writeText(str).catch(function(){ fallbackCopy(str); });
      }
    }catch(e){}
    fallbackCopy(str);
    return Promise.resolve();
  }
  function fallbackCopy(str){
    try{
      var ta=document.createElement('textarea');
      ta.value=str;ta.style.position='fixed';ta.style.opacity='0';
      document.body.appendChild(ta);ta.select();document.execCommand('copy');
      document.body.removeChild(ta);
    }catch(e){}
  }
  var lang=lsGet('nl.lang','fa')==='en'?'en':'fa', theme=lsGet('nl.theme','dark')==='light'?'light':'dark';
  var curQr=D.baseSub||location.href;
  function draw(){
    try{
      var box=document.getElementById('s-qr');
      if(!box||typeof qrcode!=='function')return;
      var th=html.getAttribute('data-theme');
      var bg=th==='dark'?'#f4f0e8':'#ffffff';
      var fg='#1D2117';
      var q=qrcode(0,'M'); q.addData(String(curQr||'')); q.make();
      box.innerHTML=q.createSvgTag({cellSize:2,margin:4,scalable:true});
      var svg=box.querySelector('svg');
      if(svg){svg.setAttribute('width','156');svg.setAttribute('height','156');
        svg.querySelectorAll('rect').forEach(function(r){r.setAttribute('fill',bg);});
        svg.querySelectorAll('path').forEach(function(p){p.setAttribute('fill',fg);});
      }
    }catch(e){}
  }
  function sync(){
    html.setAttribute('data-lang',lang); html.setAttribute('dir',lang==='fa'?'rtl':'ltr');
    html.setAttribute('data-theme',theme);
    var lb=document.getElementById('s-lang');
    if(lb) lb.textContent=lang==='fa'?'EN':'FA';
    document.querySelectorAll('.st-pick').forEach(function(b){b.classList.toggle('active',b.getAttribute('data-th')===theme);});
    draw();
  }
  var langBtn=document.getElementById('s-lang');
  if(langBtn) langBtn.onclick=function(){lang=lang==='fa'?'en':'fa';lsSet('nl.lang',lang);sync();};
  document.querySelectorAll('.st-pick').forEach(function(b){b.onclick=function(){theme=b.getAttribute('data-th');lsSet('nl.theme',theme);sync();};});
  document.querySelectorAll('.cp').forEach(function(b){
    b.onclick=function(){
      safeCopy(b.getAttribute('data-val'));
      var old=b.innerHTML; b.textContent=lang==='fa'?'رونوشت شد':'COPIED';
      setTimeout(function(){b.innerHTML=old;},1400);
    };
  });
  document.querySelectorAll('.qr-pick').forEach(function(b){
    b.onclick=function(){curQr=b.getAttribute('data-q');var lbl=document.getElementById('s-qr-label');if(lbl)lbl.textContent=b.getAttribute('data-l');draw();};
  });
  var list=document.getElementById('s-nodes');
  if(list){
    (D.nodes||[]).forEach(function(n){
      var row=document.createElement('div'); row.className='node-row';
      var titleDiv=document.createElement('div'); titleDiv.className='node-title';
      var bdg=document.createElement('span'); bdg.className='badge inv'; bdg.textContent=String(n.protocol||'');
      var st=document.createElement('strong'); st.textContent=String(n.name||'');
      titleDiv.appendChild(bdg); titleDiv.appendChild(document.createTextNode(' ')); titleDiv.appendChild(st);
      var actsDiv=document.createElement('div'); actsDiv.className='node-acts';
      var btnQr=document.createElement('button'); btnQr.className='btn ghost sm-btn'; btnQr.textContent='QR';
      var btnCp=document.createElement('button'); btnCp.className='btn sm-btn'; btnCp.textContent='COPY';
      btnQr.onclick=function(){
        curQr=n.uri;
        var lbl=document.getElementById('s-qr-label'); if(lbl) lbl.textContent=n.name;
        draw();
        var qEl=document.getElementById('s-qr');
        if(qEl&&qEl.scrollIntoView){ try{ qEl.scrollIntoView({behavior:'smooth',block:'center'}); }catch(e){} }
      };
      btnCp.onclick=function(){safeCopy(n.uri);btnCp.textContent='OK';setTimeout(function(){btnCp.textContent='COPY';},1200);};
      actsDiv.appendChild(btnQr); actsDiv.appendChild(btnCp);
      row.appendChild(titleDiv); row.appendChild(actsDiv);
      list.appendChild(row);
    });
  }
  var subModal=document.getElementById('sub-free-modal');
  var subFreeBtn=document.getElementById('s-free-btn');
  var subFreeOk=document.getElementById('sub-free-ok');
  function closeSubModal(){
    if(subModal) subModal.hidden=true;
    try{ sessionStorage.setItem('nl.free.seen','1'); }catch(e){}
  }
  if(subFreeBtn&&subModal) subFreeBtn.onclick=function(){ subModal.hidden=false; };
  if(subFreeOk) subFreeOk.onclick=closeSubModal;
  try{
    if(subModal && !sessionStorage.getItem('nl.free.seen')) subModal.hidden=false;
  }catch(e){}
  sync();
})();
</script>
</html>`;
}

export function renderDecoyGazette(assets = {}) {
  return `<!doctype html>
<html lang="en" dir="ltr" data-lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>Aral — Summit Studio</title>
<style>${assets.style || ''}</style>
</head>
<body>
<div class="bg-checker" aria-hidden="true"></div>
<div class="bg-grid" aria-hidden="true"></div>
<div class="bg-scan" aria-hidden="true"></div>
<div class="bg-beam" style="top:-70vmax;left:-20vmax" aria-hidden="true"></div>
<div class="shell">
  <header class="topbar">
    <div class="logo"><span class="logo-mark" role="img" aria-label="Aral Studio"></span><span class="logo-word">Aral<small>STUDIO</small></span></div>
    <div class="top-mid"><span class="top-tag">PIXEL&nbsp;LANDSCAPE&nbsp;GALLERY&nbsp;·&nbsp;EST.&nbsp;2026</span></div>
    <div class="top-acts"><span class="badge ok">GALLERY OPEN</span></div>
  </header>

  <section class="hero">
    <h1 class="wordmark" data-text="SUMMIT STUDIO">SUMMIT <b>STUDIO</b></h1>
    <p class="hero-sub">
      A tiny independent gallery of procedurally-drawn pixel landscapes, dithered skies
      and interactive mountain scenes — rendered live in your browser, no images attached.
    </p>
    <span class="hero-pill">EXHIBIT 01 · THE ARAAL RANGE</span>
  </section>

  <figure class="scene-figure">
    ${assets.skyline || ''}
    <figcaption class="scene-caption">
      <span class="mono">FIG. 1 — THE ARAL RANGE AT DUSK · CLICK THE SUMMIT</span>
    </figcaption>
  </figure>

  <div class="cols" style="margin-top:16px">
    <section class="card">
      <p class="kicker"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> ABOUT THE EXHIBIT</p>
      <p class="labor" style="margin:0">
        Every scene in this gallery is drawn pixel-by-pixel at load time: value-noise ridgelines,
        ordered-dither gradients, hand-tufted meadows and a wind-blown snow plume that reacts to
        your pointer. Nothing here is a photograph; the mountain is rebuilt fresh on every visit.
      </p>
      <table class="specs" style="margin-top:12px">
        <tbody>
          <tr><th>MEDIUM</th><td>HTML5 CANVAS · 2 LAYERS</td></tr>
          <tr><th>PALETTE</th><td>24 COLORS · DITHERED</td></tr>
          <tr><th>INTERACTION</th><td>PARALLAX + PARTICLES</td></tr>
        </tbody>
      </table>
    </section>
    <section class="card card-subtle">
      <p class="kicker"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14.5 14.5 0 0 1 0 18 14.5 14.5 0 0 1 0-18z"/></svg> VISITING NOTES</p>
      <p class="labor" style="margin:0">
        The gallery is open around the clock. Move your pointer across the frame to shift the
        parallax layers; click anywhere in the scene to send a burst of wind across the summit.
        Small screens get the same scene at a coarser pixel grid.
      </p>
      <div class="meter" style="margin-top:14px"><i style="width:100%"></i></div>
      <p class="hint">Rendered locally · No trackers · No cookies · Just pixels.</p>
    </section>
  </div>

  <footer class="foot">
    <span class="dot" aria-hidden="true"></span>
    <span>ARAL SUMMIT STUDIO · NOT FOR RESALE</span>
    <span class="dot" aria-hidden="true"></span>
  </footer>
</div>
<script>${assets.mtn || ''}</script>
</body>
</html>`;
}
