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
    print('PASS B9 accepted receipt + exact child balance 2.000000; family 99.000000 ignored; failed read never complete')
    browser.close()
