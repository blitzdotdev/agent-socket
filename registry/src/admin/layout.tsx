import type {Child, PropsWithChildren} from 'hono/jsx'
import {raw} from 'hono/html'

// All styling is inline: the admin makes no third-party requests.
const CSS = `
:root{
  --bg:#f6f7f9;--panel:#fff;--fg:#1d2330;--muted:#667085;--line:#e3e6eb;--line2:#eef0f3;
  --accent:#2f5bea;--accent-bg:#eaf0ff;
  --add-bg:#e9f7ee;--add-fg:#126b35;--add-ln:#d2efdc;
  --del-bg:#fdecec;--del-fg:#a1241b;--del-ln:#f6d5d3;
  --hi:#c0261d;--hi-bg:#ffe1de;--md:#8a5a00;--md-bg:#fff0c7;--lo:#3b5a8a;--lo-bg:#e6eefa;
  --ok:#137a3e;--ok-bg:#e3f5ea;--warn:#8a5a00;--warn-bg:#fff4d6;--bad:#a1241b;--bad-bg:#fde6e4;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  color-scheme:light dark;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#111418;--panel:#181c22;--fg:#e4e7ec;--muted:#98a2b3;--line:#2a3039;--line2:#222830;
  --accent:#7d9bff;--accent-bg:#1e2a4a;
  --add-bg:#13291c;--add-fg:#7ee2a2;--add-ln:#183623;
  --del-bg:#2f1716;--del-fg:#ff9b93;--del-ln:#3b1c1a;
  --hi:#ff8f86;--hi-bg:#4a1c19;--md:#f5c659;--md-bg:#3d3112;--lo:#9ab8ea;--lo-bg:#1d2a40;
  --ok:#7ee2a2;--ok-bg:#15301f;--warn:#f5c659;--warn-bg:#3a2f10;--bad:#ff9b93;--bad-bg:#3d1b19;
}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
code,pre,.mono{font-family:var(--mono);font-size:12px}
header.top{display:flex;align-items:center;gap:20px;padding:0 20px;height:44px;background:var(--panel);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
header.top .brand{font-weight:650;letter-spacing:-.01em;color:var(--fg)}
header.top .brand span{color:var(--muted);font-weight:500}
header.top nav{display:flex;gap:2px}
header.top nav a{color:var(--muted);padding:6px 10px;border-radius:6px;font-weight:500}
header.top nav a.on{color:var(--fg);background:var(--line2)}
header.top nav a:hover{text-decoration:none;color:var(--fg)}
header.top .who{margin-left:auto;color:var(--muted);font-size:12px}
main{max-width:1280px;margin:0 auto;padding:18px 20px 60px}
h1{font-size:18px;margin:0 0 4px;letter-spacing:-.01em}
h2{font-size:14px;margin:22px 0 8px}
h3{font-size:13px;margin:0}
.sub{color:var(--muted)}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.sp{flex:1}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px}
.pad{padding:12px 14px}
.flash{padding:8px 12px;border-radius:6px;margin-bottom:12px;border:1px solid}
.flash.ok{background:var(--ok-bg);color:var(--ok);border-color:transparent}
.flash.err{background:var(--bad-bg);color:var(--bad);border-color:transparent}
table.list{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}
table.list th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600;text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);background:var(--line2)}
table.list td{padding:7px 10px;border-bottom:1px solid var(--line2);vertical-align:top}
table.list tr:last-child td{border-bottom:0}
table.list tr.click:hover td{background:var(--line2)}
table.list td.num{text-align:right;font-variant-numeric:tabular-nums}
.host{font-weight:600}
.tabs{display:flex;gap:4px;margin:12px 0}
.tabs a{padding:5px 10px;border-radius:6px;color:var(--muted);border:1px solid transparent}
.tabs a.on{background:var(--panel);border-color:var(--line);color:var(--fg)}
.tabs a .n{font-variant-numeric:tabular-nums;margin-left:4px;color:var(--muted)}
.badge{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:600;line-height:17px;white-space:nowrap}
.badge.pending{background:var(--warn-bg);color:var(--warn)}
.badge.approved,.badge.published{background:var(--ok-bg);color:var(--ok)}
.badge.rejected,.badge.unpublished{background:var(--bad-bg);color:var(--bad)}
.badge.new{background:var(--accent-bg);color:var(--accent)}
.badge.update{background:var(--line2);color:var(--muted)}
.badge.added{background:var(--add-bg);color:var(--add-fg)}
.badge.removed{background:var(--del-bg);color:var(--del-fg)}
.badge.changed{background:var(--warn-bg);color:var(--warn)}
.badge.unchanged{background:var(--line2);color:var(--muted)}
.badge.disabled{background:var(--bad-bg);color:var(--bad)}
.chip{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;font-weight:600;line-height:18px;margin:0 3px 3px 0;white-space:nowrap}
.chip.high{background:var(--hi-bg);color:var(--hi)}
.chip.medium{background:var(--md-bg);color:var(--md)}
.chip.low{background:var(--lo-bg);color:var(--lo)}
.chip.act{background:var(--bad-bg);color:var(--bad)}
.stat-add{color:var(--add-fg);font-weight:600}.stat-del{color:var(--del-fg);font-weight:600}.stat-chg{color:var(--warn);font-weight:600}
.meta{display:grid;grid-template-columns:auto 1fr;gap:3px 14px;font-size:12px}
.meta dt{color:var(--muted)}.meta dd{margin:0;word-break:break-all}
.grid2{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;align-items:start}
@media (max-width:1000px){.grid2{grid-template-columns:1fr}}
.sticky{position:sticky;top:56px}
form.inline{display:inline}
textarea,input[type=text]{width:100%;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:6px 8px}
textarea{min-height:56px;resize:vertical}
button{font:inherit;font-weight:600;border-radius:6px;border:1px solid var(--line);background:var(--panel);color:var(--fg);padding:5px 12px;cursor:pointer}
button:hover{border-color:var(--muted)}
button.approve{background:var(--ok);border-color:var(--ok);color:#fff}
button.reject,button.danger{background:transparent;border-color:var(--bad);color:var(--bad)}
button.small{padding:2px 8px;font-size:12px}
.diff{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:12px;line-height:1.5;table-layout:fixed}
.diff td{padding:0 8px;vertical-align:top}
.diff td.ln{width:44px;text-align:right;color:var(--muted);user-select:none;padding:0 6px;opacity:.7}
.diff td.sg{width:16px;user-select:none;color:var(--muted);padding:0 2px 0 4px}
.diff td.tx{white-space:pre-wrap;word-break:break-word}
.diff tr.add td{background:var(--add-bg)}.diff tr.add td.ln{background:var(--add-ln)}.diff tr.add td.sg{color:var(--add-fg)}
.diff tr.del td{background:var(--del-bg)}.diff tr.del td.ln{background:var(--del-ln)}.diff tr.del td.sg{color:var(--del-fg)}
.diff tr.del .wd{background:rgba(214,45,32,.22);border-radius:2px}
.diff tr.add .wd{background:rgba(22,150,70,.26);border-radius:2px}
.diff tr.skip td{background:var(--line2);color:var(--muted);font-family:system-ui,sans-serif;font-size:11px;padding:2px 10px}
mark.risk{border-radius:3px;padding:0 1px;font-weight:700}
mark.risk.high{background:var(--hi-bg);color:var(--hi);box-shadow:0 0 0 1px var(--hi) inset}
mark.risk.medium{background:var(--md-bg);color:var(--md)}
mark.risk.low{background:var(--lo-bg);color:var(--lo)}
.tool{margin-top:12px;overflow:hidden}
.tool > .th{display:flex;gap:10px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line);background:var(--line2)}
.tool > .th .path{font-family:var(--mono);font-weight:600;font-size:12.5px}
.tool .sec{padding:0;border-bottom:1px solid var(--line2)}
.tool .sec:last-child{border-bottom:0}
.tool .lbl{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:650;padding:6px 12px 3px}
.method{font-family:var(--mono);font-size:11px;font-weight:700;color:var(--muted)}
.empty{padding:28px;text-align:center;color:var(--muted)}
details > summary{cursor:pointer;color:var(--muted);padding:6px 0}
.warnbox{background:var(--warn-bg);color:var(--warn);padding:8px 12px;border-radius:6px;margin:10px 0}
.notes-pre{white-space:pre-wrap;font-family:var(--mono);font-size:12px;margin:0;padding:10px 12px}
.pager{display:flex;gap:10px;justify-content:center;margin-top:12px;color:var(--muted)}
.toc a{font-family:var(--mono);font-size:12px}
.toc li{margin:2px 0;list-style:none}
.toc{padding:0;margin:0}
`

export function Layout(props: PropsWithChildren<{title: string, nav?: 'queue' | 'all' | 'sites', who: string, pending?: number, flash?: {kind: 'ok' | 'err', text: string} | null}>) {
    const navLink = (key: string, href: string, label: Child) =>
        <a href={href} class={props.nav === key ? 'on' : ''}>{label}</a>
    return <html lang="en">
        <head>
            <meta charset="utf-8"/>
            <meta name="viewport" content="width=device-width, initial-scale=1"/>
            <meta name="robots" content="noindex"/>
            <title>{props.title} · registry admin</title>
            <style>{raw(CSS)}</style>
        </head>
        <body>
            <header class="top">
                <a class="brand" href="/admin">agent-socket <span>registry</span></a>
                <nav>
                    {navLink('queue', '/admin/submissions?status=pending', <>Review queue{props.pending ? ` (${props.pending})` : ''}</>)}
                    {navLink('all', '/admin/submissions?status=all', 'All submissions')}
                    {navLink('sites', '/admin/sites', 'Sites')}
                </nav>
                <span class="who">{props.who}</span>
            </header>
            <main>
                {props.flash && <div class={`flash ${props.flash.kind}`}>{props.flash.text}</div>}
                {props.children}
            </main>
        </body>
    </html>
}
