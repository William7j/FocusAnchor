import type { AnnotationLocator, SelectionDraft } from '../types';

function textOffset(root: Element, target: Node, offset: number) {
  let total = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current: Node | null = walker.nextNode();
  while (current) {
    if (current === target) return total + offset;
    total += current.textContent?.length || 0;
    current = walker.nextNode();
  }
  return null;
}

export function readFlowSelection(container: HTMLElement): SelectionDraft | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement;
  const endElement = range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer as Element : range.endContainer.parentElement;
  const startBlock = startElement?.closest<HTMLElement>('[data-block-id]');
  const endBlock = endElement?.closest<HTMLElement>('[data-block-id]');
  if (!startBlock || startBlock !== endBlock || !container.contains(startBlock)) return null;
  const start = textOffset(startBlock, range.startContainer, range.startOffset);
  const end = textOffset(startBlock, range.endContainer, range.endOffset);
  const quote = selection.toString().replace(/\s+/g, ' ').trim();
  if (start === null || end === null || start >= end || !quote) return null;
  const locator: AnnotationLocator = { kind: 'flow', blockId: startBlock.dataset.blockId || '', start, end };
  return { locator, quote };
}

export function clearSelection() {
  window.getSelection()?.removeAllRanges();
}
