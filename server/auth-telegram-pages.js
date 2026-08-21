function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function telegramAuthorizePage({ botUsername = "", callbackUrl = "", botDeepLink = "" } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Task Node Telegram Sign In</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f7f6f2; color: #151512; }
    main { width: min(520px, calc(100vw - 32px)); padding: 36px 30px; background: #fff; border: 1px solid #e5e1d8; border-radius: 8px; box-shadow: 0 18px 54px rgba(0,0,0,.08); }
    h1 { margin: 0 0 12px; font-size: 26px; line-height: 1.15; letter-spacing: 0; }
    p { margin: 0 0 16px; color: #5f5b52; font-size: 15px; line-height: 1.55; }
    .step { margin-top: 14px; padding: 14px 16px; border: 1px solid #ece8df; border-radius: 8px; background: #fbfaf7; }
    .button { display: inline-flex; align-items: center; min-height: 40px; padding: 0 14px; border-radius: 6px; color: #fff; background: #111; text-decoration: none; font-weight: 650; }
    .telegram-widget { min-height: 46px; margin-top: 14px; }
    .muted { margin-top: 18px; font-size: 13px; color: #777267; }
  </style>
</head>
<body>
  <main>
    <h1>Telegram Sign In</h1>
    <p>Authorize Telegram to sign in or connect this Telegram identity to your current Task Node account.</p>
    <div class="step">
      <p>Open the Task Node Telegram bot if you want bot-side messaging continuity.</p>
      <a class="button" href="${escapeHtml(botDeepLink)}" target="_blank" rel="noopener noreferrer">Open Telegram bot</a>
    </div>
    <div class="step">
      <p>Then authorize the same Telegram account.</p>
      <div class="telegram-widget">
        <script async src="https://telegram.org/js/telegram-widget.js?22"
          data-telegram-login="${escapeHtml(botUsername)}"
          data-size="large"
          data-userpic="false"
          data-auth-url="${escapeHtml(callbackUrl)}"
          data-request-access="write"></script>
      </div>
    </div>
    <p class="muted">The server verifies Telegram's signed payload before issuing or linking an account session.</p>
  </main>
</body>
</html>`;
}

export function telegramAuthorizeErrorHtml({ title, message, actionRequired }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f7f6f2; color: #151512; }
    main { width: min(540px, calc(100vw - 32px)); padding: 34px 30px; background: #fff; border: 1px solid #e5e1d8; border-radius: 8px; box-shadow: 0 18px 54px rgba(0,0,0,.08); }
    h1 { margin: 0 0 12px; font-size: 24px; line-height: 1.18; letter-spacing: 0; }
    p { margin: 0 0 14px; color: #5f5b52; font-size: 15px; line-height: 1.55; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; background: #f2eee7; border-radius: 4px; padding: 2px 4px; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <p>${escapeHtml(actionRequired)}</p>
    <p>After updating the domain, restart the Task Node API process and start Telegram linking again.</p>
  </main>
</body>
</html>`;
}

export function telegramAuthHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self' https://telegram.org",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "frame-src https://oauth.telegram.org https://telegram.org",
      "connect-src 'self' https://telegram.org https://oauth.telegram.org",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self' https://oauth.telegram.org https://telegram.org",
      "frame-ancestors 'none'",
    ].join("; "),
  };
}
