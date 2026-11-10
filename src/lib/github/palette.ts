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
  /* Code: GitHub's light syntax colors in the light theme, its dark ones in the dark theme. */
  color-scheme: inherit;
  --prettylights-syntax-comment: var(--fg-muted);
  --prettylights-syntax-storageModifierImport: var(--fg);
  --prettylights-syntax-markup-bold: var(--fg);
  --prettylights-syntax-markup-italic: var(--fg);
  --prettylights-syntax-bracketHighlighterAngle: var(--fg-muted);
  --prettylights-syntax-constant: light-dark(#0550ae, #79c0ff);
  --prettylights-syntax-constantOtherReferenceLink: light-dark(#0a3069, #a5d6ff);
  --prettylights-syntax-entity: light-dark(#6639ba, #d2a8ff);
  --prettylights-syntax-entityTag: light-dark(#0550ae, #7ee787);
  --prettylights-syntax-keyword: light-dark(#cf222e, #ff7b72);
  --prettylights-syntax-string: light-dark(#0a3069, #a5d6ff);
  --prettylights-syntax-stringRegexp: light-dark(#116329, #7ee787);
  --prettylights-syntax-variable: light-dark(#953800, #ffa657);
  --prettylights-syntax-bracketHighlighterUnmatched: light-dark(#82071e, #f85149);
  --prettylights-syntax-markup-heading: light-dark(#0550ae, #1f6feb);
  --prettylights-syntax-markup-list: light-dark(#3b2300, #f2cc60);
  --prettylights-syntax-metaDiffRange: light-dark(#8250df, #d2a8ff);
  --prettylights-syntax-sublimeLinterGutterMark: light-dark(#818b98, #3d444d);
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
.markdown-body mark.hl-found { background: #f5d34f; color: #1f2328; border-radius: 2px; padding: 0 1px; }
.markdown-body mark.hl-explained { background: var(--acc1-soft); box-shadow: inset 0 -1px 0 var(--acc1); color: inherit; border-radius: 2px; padding: 0 1px; cursor: pointer; }

.markdown-body .snippet-clipboard-content > pre,
.markdown-body .highlight > pre { flex: 1; }
`
