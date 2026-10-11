// Fig 3: the extension's popup on a connected tab, drawn from its real
// layout and labels (chrome-extension/popup.html), with the five controls
// numbered and explained beside it. The real popup is set in a monospace face;
// here it is in the page's sans.

export function popupHtml() {
  const n = (i) => `<span class="pp-n" aria-hidden="true">${i}</span>`
  return `<figure class="pp" aria-labelledby="pp-cap">
  <div class="pp-plate">
    <div class="pp-corner pp-fig" aria-hidden="true">Fig 3</div><div class="pp-corner pp-title" aria-hidden="true">The extension, on a connected tab</div>
    <div class="pp-grid">
      <div class="pp-pop" role="img" aria-label="The Agent Socket popup on a connected github.com tab: the tab and its status, an auto-stop timer with Stop now, the allowed site, Stop and disconnect, the link to copy, and the last three actions.">
        <div class="pp-head"><b>Agent Socket</b><i class="pp-ok"></i></div>
        <div class="pp-card">${n(1)}<div class="pp-mut">Connected tab</div><div class="pp-tab"><span class="pp-fav"></span><span><b>Pull requests · acme/web</b><span class="pp-mut">github.com</span></span></div><div>AI active, last tool call: click, 8 s ago</div></div>
        <div class="pp-card">${n(2)}<div class="pp-strong">Auto-stop in 42:10</div><div class="pp-row"><span class="pp-btn pp-red">Stop now</span><span class="pp-btn">Change</span><span class="pp-btn">Remove timer</span></div></div>
        <div class="pp-card">${n(3)}<div class="pp-mut">Sites the AI can use in this tab:</div><div class="pp-site"><span>github.com</span><u>remove</u></div><div class="pp-check"><i></i>Let the AI use other sites in this tab</div></div>
        <div class="pp-stop">${n(5)}Stop &amp; disconnect</div>
        <div class="pp-card"><div class="pp-mut">Paste this URL into your AI chat:</div><div class="pp-row"><span class="pp-url">https://agentsocket.dev/v1/t/as_7K2Q…</span><span class="pp-btn pp-pink">Copy</span></div></div>
        <div class="pp-card">${n(4)}<div class="pp-row pp-sb"><span class="pp-mut">Activity</span><span class="pp-btn">Open activity log</span></div>
          <div class="pp-act"><span>14:02:19</span><span>click "Merge pull request"</span><b class="pp-200">200</b></div>
          <div class="pp-act"><span>14:02:11</span><span>get_text .diff-stats</span><b class="pp-200">200</b></div>
          <div class="pp-act"><span>14:01:58</span><span>navigate mail.google.com</span><b class="pp-403">403</b></div>
        </div>
      </div>
      <ol class="pp-notes">
        <li>${n(1)}<div><b>One tab per link.</b> The agent reaches the tab you connected and nothing else in the browser. Connect another tab and it gets its own link, timer and limits.</div></li>
        <li>${n(2)}<div><b>It stops by itself.</b> A session ends 60 minutes after you connect, unless you change or remove the timer. When it runs out, the link dies at once.</div></li>
        <li>${n(3)}<div><b>Locked to the site you chose.</b> If the tab ends up somewhere else, from a redirect or a link the agent clicked, its calls are refused until you allow that site.</div></li>
        <li>${n(4)}<div><b>A log of everything it did.</b> Every action, refused ones included, kept on your computer for 7 days. Typed text stays hidden unless you ask for full detail.</div></li>
        <li>${n(5)}<div><b>Stop means stop.</b> One click ends the session and the link with it; closing the tab does the same. The page also shows an "AI has access to this tab" bar with its own Stop.</div></li>
      </ol>
    </div>
  </div>
  <figcaption id="pp-cap" class="iso-legend"><span class="iso-caption"><b>Fig 3.</b> The popup on a connected tab. The site, the actions and the times are an example.</span></figcaption>
</figure>`
}

export const POPUP_CSS = `
.pp{margin:30px 0 0}
.pp-plate{position:relative;border-radius:12px;box-shadow:0 0 0 1px var(--rule);background:#fcfcfb;padding:48px 28px 34px}
.pp-corner{position:absolute;top:18px;font-size:12px;color:var(--muted)}
.pp-fig{left:20px;color:var(--text)}.pp-title{right:20px}
.pp-grid{display:grid;grid-template-columns:330px 1fr;gap:40px;align-items:start}
.pp-pop{position:relative;background:#0f0f12;color:#e8e8ec;border-radius:12px;padding:12px;font-size:12px;line-height:1.4;box-shadow:0 1px 0 #ffffff14 inset,0 18px 40px -18px #00000066,0 0 0 1px #00000014}
.pp-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:9px;font-size:13px}
.pp-ok{width:9px;height:9px;border-radius:50%;background:#5ad06a;box-shadow:0 0 6px #5ad06a99}
.pp-card{position:relative;min-width:0;background:#1a1a1f;border:1px solid #2a2a30;border-radius:8px;padding:9px 10px;margin-bottom:8px;display:grid;gap:6px}
.pp-mut{color:#8c8c93;font-size:11.5px}
.pp-strong{font-weight:600;font-size:13px}
.pp-tab{display:flex;gap:8px;align-items:center}.pp-tab>span:last-child{display:grid}
.pp-fav{width:14px;height:14px;border-radius:50%;background:#e8e8ec}
.pp-row{display:flex;gap:6px;align-items:center}.pp-sb{justify-content:space-between}
.pp-btn{flex:none;padding:3px 8px;border-radius:5px;border:1px solid #34343b;color:#d8d8dd;font-size:11.5px;white-space:nowrap}
.pp-red{background:#f06;border-color:#f06;color:#fff}.pp-pink{background:#f06;border-color:#f06;color:#fff}
.pp-site{display:flex;justify-content:space-between}.pp-site u{color:#ff6b9a;text-decoration-color:#ff6b9a80}
.pp-check{display:flex;gap:7px;align-items:center;color:#c8c8ce}.pp-check i{width:11px;height:11px;border:1px solid #55555d;border-radius:3px}
.pp-stop{position:relative;margin-bottom:8px;padding:9px;border-radius:8px;background:#ff5c5c;color:#fff;font-weight:600;text-align:center;font-size:12.5px}
.pp-url{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#0f0f12;border:1px solid #2a2a30;border-radius:5px;padding:3px 7px;color:#c8c8ce}
.pp-act{display:grid;grid-template-columns:52px 1fr auto;gap:8px;border-top:1px solid #2a2a30;padding-top:5px;font-size:11.5px}
.pp-act span:first-child{color:#8c8c93}.pp-act span:nth-child(2){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pp-200{color:#5ad06a;font-weight:600}.pp-403{color:#ffb547;font-weight:600}
.pp-n{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;background:#fff;color:#1d1d20;border:1px solid #c9c9c6;font-size:10.5px;font-weight:600;font-variant-numeric:tabular-nums}
.pp-pop .pp-n{position:absolute;left:-30px;top:8px;box-shadow:0 0 0 3px #fcfcfb}
.pp-pop .pp-stop .pp-n{top:7px}
.pp-notes{list-style:none;margin:0;padding:0;display:grid;gap:18px;font-size:14px;line-height:1.5}
.pp-notes li{display:grid;grid-template-columns:28px 1fr;align-items:start}
.pp-notes li .pp-n{margin-top:1px}
.pp-notes b{color:var(--ink);font-weight:550}
@media (max-width:820px){.pp-plate{padding:46px 16px 26px}.pp-grid{grid-template-columns:minmax(0,1fr);gap:26px}.pp-grid>*{min-width:0}.pp-pop{margin-left:30px;max-width:min(340px,calc(100% - 30px))}}
`
