export const APP_PALETTE = `
[data-color-mode][data-dark-theme][data-a11y-link-underlines] {
  --bgColor-default: transparent;
  --bgColor-muted: var(--bg-subtle);
  --bgColor-inset: var(--bg-subtle);
  --bgColor-neutral-muted: var(--bg-muted);
  --color-canvas-default: transparent;
  --color-canvas-subtle: var(--bg-subtle);
  --fgColor-default: var(--fg);
  --fgColor-muted: var(--fg-muted);
  --fgColor-accent: var(--acc1);
  --fgColor-link: var(--acc1);
  --color-fg-default: var(--fg);
  --color-fg-muted: var(--fg-muted);
  --color-accent-fg: var(--acc1);
  --borderColor-default: var(--border);
  --borderColor-muted: var(--border-muted);
  --borderColor-accent-emphasis: var(--acc1);
  --color-border-default: var(--border);
  --color-border-muted: var(--border-muted);
}

.markdown-body { background-color: transparent; color: var(--fg); font-size: 16px; }
.markdown-body table tr { background-color: transparent; }
.markdown-body table tr:nth-child(2n) { background-color: var(--bg-subtle); }
.markdown-body table th { background-color: var(--bg-subtle); }
.markdown-body code, .markdown-body tt { background-color: var(--bg-muted); }
.markdown-body pre, .markdown-body .highlight pre { background-color: var(--bg-subtle); }

.markdown-body mark.hl-yellow { background: var(--mark); color: inherit; border-radius: 2px; padding: 0 1px; }
.markdown-body mark.hl-green { background: var(--ok-soft); box-shadow: inset 0 -1px 0 var(--ok); color: inherit; border-radius: 2px; padding: 0 1px; }
.markdown-body mark.hl-pink { background: var(--bad-soft); box-shadow: inset 0 -1px 0 var(--bad); color: inherit; border-radius: 2px; padding: 0 1px; }
.markdown-body mark.hl-explained { background: var(--acc1-soft); box-shadow: inset 0 -1px 0 var(--acc1); color: inherit; border-radius: 2px; padding: 0 1px; cursor: pointer; }

.markdown-body .snippet-clipboard-content > pre,
.markdown-body .highlight > pre { flex: 1; }
`
