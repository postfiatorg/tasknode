"""Mocked browser evidence only. Requires the isolated Vite dev server at 127.0.0.1:5188."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

out = Path(os.environ['BRIDGE_EVIDENCE'])
base = 'http://127.0.0.1:5188/src/features/wallet/l1/bridge/browser-fixture.html'
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1200, 'height': 1100})
    page.on('pageerror', lambda error: print('BROWSER ERROR:', error))
    for mode in ['blocked', 'offline']:
        page.goto(f'{base}?mode={mode}')
        expect(page.get_by_text('Bridge blocked', exact=True)).to_be_visible()
        page.get_by_role('button', name='Connect MetaMask', exact=True).click()
        expect(page.get_by_text('Ethereum mainnet: 0x' + '44' * 20)).to_be_visible()
        page.get_by_label('USDC amount', exact=True).fill('1')
        expect(page.get_by_role('button', name='Approve', exact=True)).to_be_disabled()
        expect(page.get_by_role('button', name='Deposit', exact=True)).to_be_disabled()
        assert page.evaluate('window.mockSends.length') == 0
        page.screenshot(path=str(out / f'B10-{mode}.png'), full_page=True)
        print(f'PASS B10 {mode}: Approve/Deposit disabled; zero provider sends')
    page.goto(f'{base}?mode=ready')
    expect(page.get_by_text('Bridge ready', exact=True)).to_be_visible()
    page.get_by_role('button', name='Connect MetaMask', exact=True).click()
    expect(page.get_by_text('Recipient on Post Fiat: pf' + '33' * 20)).to_be_visible()
    page.get_by_label('USDC amount', exact=True).fill('1')
    page.screenshot(path=str(out / 'B7-connected-recipient.png'), full_page=True)
    page.get_by_role('button', name='Approve', exact=True).click()
    expect(page.get_by_role('link', name='Ethereum approval', exact=True)).to_be_visible()
    page.get_by_role('button', name='Deposit', exact=True).click()
    expect(page.get_by_text('Job', exact=False).filter(has_text='proving')).to_be_visible()
    assert len(page.locator('ol[aria-label="Relay stages"] li').all()) == 7
    assert page.evaluate('window.mockSends.length') == 2
    job_before = page.get_by_text('Job', exact=False).filter(has_text='proving').inner_text()
    page.screenshot(path=str(out / 'B8-proving-stages.png'), full_page=True)
    page.reload()
    expect(page.get_by_text(job_before, exact=True)).to_be_visible()
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
    expect(page.get_by_text('Claim accepted — current balance: 2.000000 PFUSDC', exact=True)).to_be_visible()
    expect(page.get_by_text('Credited asset: ' + '6e' * 48, exact=True)).to_be_visible()
    assert '99.000000' not in page.locator('body').inner_text()
    page.screenshot(path=str(out / 'B9-credited-child-balance.png'), full_page=True)
    print('PASS B9 accepted receipt + exact child balance 2.000000; family 99.000000 ignored; failed read never complete')
    browser.close()
