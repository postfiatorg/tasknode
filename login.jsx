<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Log in or sign up</title>
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    height: 100%;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #f3f3f3;
    -webkit-font-smoothing: antialiased;
    color: #0d0d0d;
  }
 
  .page {
    min-height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
 
  .modal {
    width: 100%;
    max-width: 480px;
    background: #ffffff;
    border-radius: 24px;
    padding: 40px 36px 36px;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.08);
    position: relative;
  }
 
  .close {
    position: absolute;
    top: 18px;
    right: 18px;
    width: 32px;
    height: 32px;
    border: none;
    background: transparent;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    color: #0d0d0d;
  }
  .close:hover { background: #f5f5f5; }
  .close svg { width: 18px; height: 18px; }
 
  h1 {
    font-size: 30px;
    font-weight: 600;
    text-align: center;
    margin: 4px 0 14px;
    letter-spacing: -0.5px;
  }
 
  .subtitle {
    text-align: center;
    color: #0d0d0d;
    font-size: 16px;
    line-height: 1.45;
    margin: 0 0 28px;
    padding: 0 8px;
  }
 
  .provider-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    width: 100%;
    padding: 14px 18px;
    margin-bottom: 12px;
    border: 1px solid #d9d9d9;
    border-radius: 999px;
    background: #ffffff;
    font-size: 16px;
    font-weight: 500;
    color: #0d0d0d;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
    font-family: inherit;
  }
  .provider-btn:hover {
    background: #f7f7f7;
  }
  .provider-btn svg, .provider-btn .icon {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
  }
 
  .divider {
    display: flex;
    align-items: center;
    text-align: center;
    color: #0d0d0d;
    font-size: 14px;
    margin: 22px 0 18px;
  }
  .divider::before, .divider::after {
    content: "";
    flex: 1;
    border-bottom: 1px solid #e5e5e5;
  }
  .divider::before { margin-right: 14px; }
  .divider::after  { margin-left: 14px; }
 
  .email-input {
    width: 100%;
    padding: 14px 20px;
    border: 1px solid #b4b4b4;
    border-radius: 999px;
    font-size: 16px;
    font-family: inherit;
    outline: none;
    margin-bottom: 14px;
    color: #0d0d0d;
    background: #ffffff;
  }
  .email-input::placeholder { color: #8e8e8e; }
  .email-input:focus { border-color: #0d0d0d; }
 
  .continue-btn {
    width: 100%;
    padding: 15px 20px;
    border: none;
    border-radius: 999px;
    background: #0d0d0d;
    color: #ffffff;
    font-size: 16px;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
    transition: background 0.15s ease;
  }
  .continue-btn:hover { background: #2a2a2a; }
 
  @media (max-width: 520px) {
    .modal { padding: 36px 22px 26px; border-radius: 20px; }
    h1 { font-size: 26px; }
    .subtitle { font-size: 15px; }
  }
</style>
</head>
<body>
  <div class="page">
    <div class="modal" role="dialog" aria-labelledby="modal-title">
      <button class="close" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
 
      <h1 id="modal-title">Log in or sign up</h1>
      <p class="subtitle">You'll get smarter responses and can upload files, images, and more.</p>
 
      <!-- Telegram -->
      <button class="provider-btn" type="button">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle cx="12" cy="12" r="12" fill="#229ED9"/>
          <path d="M5.5 11.7l11.6-4.48c.54-.2 1.01.13.84.94l-1.98 9.32c-.15.69-.56.86-1.13.54l-3.13-2.31-1.51 1.45c-.17.17-.31.31-.63.31l.22-3.18 5.79-5.23c.25-.22-.06-.35-.39-.13l-7.16 4.51-3.08-.96c-.67-.21-.68-.67.16-.99z" fill="#ffffff"/>
        </svg>
        Continue with Telegram
      </button>
 
      <!-- Discord -->
      <button class="provider-btn" type="button">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M20.317 4.369A19.79 19.79 0 0 0 16.558 3.2a.074.074 0 0 0-.079.037c-.34.6-.719 1.384-.984 2.003a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-1-2.003.077.077 0 0 0-.079-.037 19.74 19.74 0 0 0-3.76 1.169.07.07 0 0 0-.032.027C2.533 8.046 1.91 11.62 2.215 15.15a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.042-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.371-.291a.074.074 0 0 1 .077-.01c3.927 1.793 8.18 1.793 12.061 0a.073.073 0 0 1 .078.009c.12.099.245.198.372.292a.077.077 0 0 1-.006.128 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-4.082-.838-7.625-3.549-10.755a.061.061 0 0 0-.031-.028zM8.02 13.001c-1.182 0-2.157-1.085-2.157-2.418 0-1.333.956-2.418 2.157-2.418 1.21 0 2.176 1.094 2.157 2.418 0 1.333-.956 2.418-2.157 2.418zm7.974 0c-1.183 0-2.157-1.085-2.157-2.418 0-1.333.955-2.418 2.157-2.418 1.21 0 2.176 1.094 2.157 2.418 0 1.333-.946 2.418-2.157 2.418z" fill="#5865F2"/>
        </svg>
        Continue with Discord
      </button>
 
      <!-- X -->
      <button class="provider-btn" type="button">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817-5.965 6.817H1.68l7.73-8.835L1.254 2.25h6.83l4.713 6.231 5.447-6.231zm-1.161 17.52h1.833L7.084 4.126H5.117l11.966 15.644z" fill="#0d0d0d"/>
        </svg>
        Continue with X
      </button>

      <!-- GitHub -->
      <button class="provider-btn" type="button">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M12 2C6.477 2 2 6.59 2 12.253c0 4.528 2.865 8.369 6.839 9.726.5.095.683-.222.683-.494 0-.244-.009-.889-.014-1.745-2.782.62-3.369-1.375-3.369-1.375-.455-1.187-1.11-1.503-1.11-1.503-.908-.637.069-.624.069-.624 1.004.073 1.532 1.057 1.532 1.057.892 1.566 2.341 1.114 2.91.852.091-.663.349-1.114.635-1.37-2.221-.259-4.556-1.139-4.556-5.07 0-1.12.39-2.036 1.029-2.753-.103-.259-.446-1.302.098-2.714 0 0 .84-.276 2.75 1.052A9.37 9.37 0 0 1 12 5.949a9.37 9.37 0 0 1 2.504.346c1.909-1.328 2.747-1.052 2.747-1.052.546 1.412.203 2.455.1 2.714.64.717 1.028 1.633 1.028 2.753 0 3.941-2.339 4.808-4.566 5.062.359.318.679.945.679 1.904 0 1.374-.012 2.482-.012 2.819 0 .274.18.594.688.493C19.138 20.619 22 16.779 22 12.253 22 6.59 17.523 2 12 2z" fill="#0d0d0d"/>
        </svg>
        Continue with GitHub
      </button>
 
      <div class="divider">OR</div>
 
      <input class="email-input" type="email" placeholder="Email address" aria-label="Email address" />
 
      <button class="continue-btn" type="button">Continue</button>
    </div>
  </div>
 
  <script>
    document.querySelector('.close').addEventListener('click', () => {
      const modal = document.querySelector('.modal');
      modal.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
      modal.style.opacity = '0';
      modal.style.transform = 'scale(0.96)';
    });
  </script>
</body>
</html>
 
