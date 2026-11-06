document.getElementById('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = document.getElementById('username').value.trim().toLowerCase();
    const password = document.getElementById('password').value.trim();

    try {
        const response = await fetch('./login/authenticate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username,
                password
            })
        });

        const { success, status, message } = await response.json();
        if (!success) {
            const passwordError = document.getElementById('passwordError');
            passwordError.textContent = '⚠️ Wrong Credentials.';
            throw new Error(`Login failed with status ${status}: ${message}`);
        }

        window.location.href = './panel';
    } catch (error) {
        console.error('Login error:', error.message || error);
    }
});

document.getElementById('togglePassword').addEventListener('click', function () {
    const passwordInput = document.getElementById('password');
    const isPassword = passwordInput.type === 'password';
    passwordInput.type = isPassword ? 'text' : 'password';
    this.textContent = isPassword ? 'visibility_off' : 'visibility';
});
/* ---------- Aral Sulfur: dark / light theme ---------- */
(function initTheme() {
    const root = document.documentElement;
    const toggle = document.getElementById('themeSwitch');

    const stored = localStorage.getItem('aral-sulfur-theme');
    const isLight = stored ? stored === 'light' : window.matchMedia('(prefers-color-scheme: light)').matches;

    root.setAttribute('data-theme', isLight ? 'light' : 'dark');
    if (toggle) toggle.checked = !isLight;

    if (toggle) {
        toggle.addEventListener('change', () => {
            const theme = toggle.checked ? 'dark' : 'light';
            root.setAttribute('data-theme', theme);
            localStorage.setItem('aral-sulfur-theme', theme);
        });
    }
})();
