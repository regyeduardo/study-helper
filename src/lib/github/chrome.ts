const COPY_ICON = `<svg aria-hidden="true" height="16" viewBox="0 0 16 16" version="1.1" width="16" class="octicon octicon-copy js-clipboard-copy-icon"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"></path><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"></path></svg>`

const LINK_ICON = `<svg class="octicon octicon-link" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="m7.775 3.275 1.25-1.25a3.5 3.5 0 1 1 4.95 4.95l-2.5 2.5a3.5 3.5 0 0 1-4.95 0 .751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018 1.998 1.998 0 0 0 2.83 0l2.5-2.5a2.002 2.002 0 0 0-2.83-2.83l-1.25 1.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042Zm-4.69 9.64a1.998 1.998 0 0 0 2.83 0l1.25-1.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042l-1.25 1.25a3.5 3.5 0 1 1-4.95-4.95l2.5-2.5a3.5 3.5 0 0 1 4.95 0 .751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018 1.998 1.998 0 0 0-2.83 0l-2.5 2.5a1.998 1.998 0 0 0 0 2.83Z"></path></svg>`

export const FIT_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" class="octicon m-2"><path fill-rule="evenodd" d="M3.72 3.72a.75.75 0 011.06 1.06L2.56 7h10.88l-2.22-2.22a.75.75 0 011.06-1.06l3.5 3.5a.75.75 0 010 1.06l-3.5 3.5a.75.75 0 11-1.06-1.06l2.22-2.22H2.56l2.22 2.22a.75.75 0 11-1.06 1.06l-3.5-3.5a.75.75 0 010-1.06l3.5-3.5z"></path></svg>`

export const COPY_ICON_MARKUP = COPY_ICON

function slug(text: string): string {
  return text.toLowerCase().trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-')
}

export function iconButton(label: string, icon: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'btn my-2 mr-2 p-0 d-inline-flex'
  button.setAttribute('aria-label', label)
  button.innerHTML = icon
  button.addEventListener('click', onClick)
  return button
}

export function headingAnchors(root: ParentNode) {
  root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(heading => {
    if (heading.parentElement?.querySelector(':scope > a.anchor')) return

    const id = slug(heading.textContent ?? '')
    heading.classList.add('heading-element')
    const wrapper = document.createElement('div')
    wrapper.className = 'markdown-heading'
    heading.replaceWith(wrapper)
    wrapper.appendChild(heading)

    const anchor = document.createElement('a')
    anchor.className = 'anchor'
    anchor.href = `#${id}`
    anchor.setAttribute('aria-label', `Permalink: ${heading.textContent?.trim() ?? ''}`)
    anchor.innerHTML = LINK_ICON
    wrapper.appendChild(anchor)
  })
}

export function copyButtons(root: ParentNode) {
  root.querySelectorAll('pre').forEach(code => {
    if (code.closest('.highlight-source-mermaid')) return

    let block = code.closest('.highlight')
    if (!block) {
      block = document.createElement('div')
      code.replaceWith(block)
      block.appendChild(code)
    }
    block.classList.add('snippet-clipboard-content', 'notranslate', 'position-relative', 'overflow-auto')

    const container = document.createElement('div')
    container.className = 'zeroclipboard-container position-absolute top-0 right-0'
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('aria-label', 'Copiar o código')
    button.className = 'ClipboardButton btn btn-invisible js-clipboard-copy m-2 p-0 d-flex flex-justify-center flex-items-center'
    button.innerHTML = COPY_ICON
    button.addEventListener('click', () => navigator.clipboard?.writeText(code.textContent ?? ''))
    container.appendChild(button)
    block.appendChild(container)
  })
}
