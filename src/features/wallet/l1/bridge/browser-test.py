"""Mocked browser evidence only. Requires the isolated Vite dev server at 127.0.0.1:5188."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

out = Path(os.environ['BRIDGE_EVIDENCE'])
base = os.environ.get('BRIDGE_FIXTURE_ORIGIN', 'http://127.0.0.1:5188') + '/src/features/wallet/l1/bridge/browser-fixture.html'
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1200, 'height': 1100})
    page.on('pageerror', lambda error: print('BROWSER ERROR:', error))
    for mode in ['blocked', 'offline']:
        page.goto(f'{base}?mode={mode}')
        expect(page.get_by_text('Bridge unavailable', exact=True)).to_be_visible()
        page.get_by_role('button', name='Connect MetaMask', exact=True).click()
        expect(page.get_by_test_id('bridge-owner')).to_have_text('0x' + '44' * 20)
        page.get_by_label('USDC amount', exact=True).fill('1')
        expect(page.get_by_role('button', name='Approve USDC', exact=True)).to_be_disabled()
        expect(page.get_by_role('button', name='Deposit', exact=True)).to_be_disabled()
        assert page.evaluate('window.mockSends.length') == 0
        page.screenshot(path=str(out / f'B10-{mode}.png'), full_page=True)
        print(f'PASS B10 {mode}: Approve/Deposit disabled; zero provider sends')
    page.goto(f'{base}?mode=ready')
    expect(page.get_by_text('Bridge ready', exact=True)).to_be_visible()
    page.get_by_role('button', name='Connect MetaMask', exact=True).click()
    expect(page.get_by_test_id('bridge-recipient')).to_have_text('pf' + '33' * 20)
    page.get_by_label('USDC amount', exact=True).fill('1')
    page.screenshot(path=str(out / 'B7-connected-recipient.png'), full_page=True)
    page.get_by_role('button', name='Approve USDC', exact=True).click()
    expect(page.get_by_role('link', name='Approval on Etherscan', exact=True)).to_be_visible()
    page.get_by_role('button', name='Deposit', exact=True).click()
    expect(page.get_by_test_id('bridge-job')).to_contain_text('proving')
    assert len(page.locator('ol[aria-label="Relay stages"] li').all()) == 7
    assert page.evaluate('window.mockSends.length') == 2
    job_before = page.get_by_test_id('bridge-job').text_content()
    page.screenshot(path=str(out / 'B8-proving-stages.png'), full_page=True)
    page.reload()
    expect(page.get_by_test_id('bridge-job')).to_have_text(job_before)
    expect(page.get_by_label('USDC amount', exact=True)).to_be_disabled()
    expect(page.get_by_text('A deposit is still in progress', exact=True)).to_be_visible()
    assert page.evaluate('window.mockSends.length') == 0
    page.screenshot(path=str(out / 'B8-reloaded-same-job.png'), full_page=True)
    print('PASS B7/B8 connect, approval/deposit ABI, seven stages, reload same job; no repeat send')
    page.evaluate("sessionStorage.setItem('mock:stage', 'accepted')")
    page.goto(f'{base}?mode=balance-fail')
    expect(page.get_by_text('Claim accepted; credited balance is unverified. Refresh the result.')).to_be_visible()
    expect(page.get_by_text('Mock balance RPC unavailable', exact=True)).to_be_visible()
    assert 'current balance:' not in page.locator('body').inner_text()
    page.screenshot(path=str(out / 'B9-balance-failure.png'), full_page=True)
    page.goto(f'{base}?mode=ready')
    expect(page.get_by_text('PFUSDC credited', exact=True)).to_be_visible()
    expect(page.get_by_test_id('bridge-credited-balance')).to_have_text('2.00')
    expect(page.get_by_test_id('bridge-credited-asset')).to_have_text('6e' * 48)
    assert '99.00' not in page.locator('body').text_content()
    page.screenshot(path=str(out / 'B9-credited-child-balance.png'), full_page=True)
    # A finished earlier deposit must not lock the form on a later visit.
    expect(page.get_by_text('Your last deposit is complete', exact=True)).to_be_visible()
    page.get_by_role('button', name='Connect MetaMask', exact=True).click()
    amount = page.get_by_label('USDC amount', exact=True)
    expect(amount).to_be_enabled()
    amount.click(); page.keyboard.type('2.5', delay=400)
    expect(amount).to_have_value('2.5')
    expect(page.get_by_role('button', name='Approve USDC', exact=True)).to_be_enabled()
    page.wait_for_timeout(17000)  # across a background readiness check
    amount.click(); page.keyboard.type('1', delay=100)
    expect(amount).to_have_value('2.51')
    page.screenshot(path=str(out / 'B11-credited-form-unlocked.png'), full_page=True)
    print('PASS B11 credited earlier deposit leaves the amount box usable; typing survives background checks')
    print('PASS B9 accepted receipt + exact child balance 2.000000; family 99.000000 ignored; failed read never complete')
    # Solana pilot: Phantom signs the server-built transfer, then the advance is polled until paid.
    page.evaluate("localStorage.clear(); sessionStorage.clear()")
    page.goto(f'{base}?mode=ready')
    expect(page.get_by_text('Pilot ready', exact=True)).to_be_visible()
    page.get_by_role('button', name='Connect Phantom', exact=True).click()
    expect(page.get_by_test_id('solana-owner')).to_be_visible()
    page.get_by_label('Solana USDC amount', exact=True).fill('30')
    expect(page.get_by_test_id('solana-send')).to_be_disabled()  # above what the float can pay
    page.get_by_label('Solana USDC amount', exact=True).fill('2.5')
    page.get_by_test_id('solana-send').click()
    expect(page.get_by_test_id('solana-paid')).to_contain_text('+2.50', timeout=15000)
    calls = page.evaluate('window.mockSolana')
    intent = next(c for c in calls if c.get('url', '').endswith('/solana/intent'))
    assert intent['body'] == {'owner': 'So1anaOwner1111111111111111111111111111111', 'amount_atoms': '2500000', 'pftl_account': 'pf' + '33' * 20}, intent
    assert [c for c in calls if c.get('phantom')] == [{'phantom': 'signAndSendTransaction', 'message': '3mJr7AoUXx2Wqd'}]
    page.reload()
    expect(page.get_by_test_id('solana-paid')).to_be_visible()
    assert not [c for c in page.evaluate('window.mockSolana') if c.get('phantom')]
    page.screenshot(path=str(out / 'B12-solana-paid.png'), full_page=True)
    print('PASS B12 Solana pilot: one Phantom send of the server-built message, paid result survives reload with no resend')
    browser.close()
