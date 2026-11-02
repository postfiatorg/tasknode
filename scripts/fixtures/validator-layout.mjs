import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

// Use the real rendered components and styles: DOM presence alone misses clipped badges.
export async function verifyValidatorLayout({ operator, menu }) {
  const directory = await mkdtemp(join(tmpdir(), "validator-layout-"));
  try {
    const css = await Promise.all(["src/styles-composer.css", "src/features/directory/directory.css", "src/features/research/validator-status.css"].map(file => readFile(file, "utf8")));
    const rows = ["short", "validator_operator_with_a_long_public_handle"].flatMap(handle => [650, 960].map(width =>
      `<div class="directory-row" style="width:${width}px"><span>1</span>${operator(handle)}${"<span>0</span>".repeat(5)}</div>`)).join("");
    const file = join(directory, "layout.html");
    await writeFile(file, `<!doctype html><html><head><style>*{box-sizing:border-box}${css.join("\n")}</style></head>
      <body>${rows}<div style="width:242px">${menu}</div><script>
      const within=(child,parent)=>{const c=child.getBoundingClientRect(),p=parent.getBoundingClientRect();return c.width>=14&&c.height>=14&&c.left>=p.left-1&&c.right<=p.right+1&&c.top>=p.top-1&&c.bottom<=p.bottom+1;};
      const marks=[...document.querySelectorAll('.directory-row .validator-mark')];
      const menu=document.querySelector('.validator-menu-row');
      const pass=marks.length===4&&marks.every(mark=>within(mark,mark.closest('.directory-operator-copy'))&&within(mark.querySelector('svg'),mark))&&within(menu.querySelector('svg'),menu)&&within(menu.querySelector('.validator-menu-status'),menu);
      document.body.dataset.layoutProof=pass?'pass':'fail';
      const details=document.createElement('pre');details.id='layout-details';details.textContent=JSON.stringify({marks:marks.map(mark=>({mark:mark.getBoundingClientRect(),parent:mark.closest('.directory-operator-copy').getBoundingClientRect(),svg:mark.querySelector('svg').getBoundingClientRect()})),menu:menu.getBoundingClientRect(),icon:menu.querySelector('svg').getBoundingClientRect(),status:menu.querySelector('.validator-menu-status').getBoundingClientRect()});document.body.append(details);
      </script></body></html>`);
    const result = spawnSync(process.env.CHROME_BIN, ["--headless", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-dev-shm-usage", "--window-size=1440,1100", "--virtual-time-budget=1000", "--dump-dom", pathToFileURL(file).href], { encoding: "utf8", timeout: 30000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.error?.message || result.stderr.slice(-1000));
    assert.ok(result.stdout.includes('data-layout-proof="pass"'), `validator chips and dual-network menu icon must fit inside their visible containers: ${result.stdout.slice(-4000)} ${result.stderr.slice(-1000)}`);
    console.log("validator layout browser proof ok: long/short handles at two widths, visible chip and dual-network menu icon");
  } finally { await rm(directory, { recursive: true, force: true }); }
}
