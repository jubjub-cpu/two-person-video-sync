import type { VideoCandidateSummary } from "../types";

export interface PlayerDescriptor {
  width: number;
  height: number;
  visibleRatio: number;
  centerDistance: number;
  playing: boolean;
  audible: boolean;
  loop: boolean;
  muted: boolean;
  likelyAdvertisement: boolean;
}

interface Candidate {
  id: string;
  element: HTMLVideoElement;
  score: number;
}

export function rankPlayer(descriptor: PlayerDescriptor): number {
  const areaScore = Math.min(60, Math.log2(Math.max(1, descriptor.width * descriptor.height)) * 3);
  const visibility = descriptor.visibleRatio * 35;
  const centrality = Math.max(0, 15 - descriptor.centerDistance * 15);
  const active = descriptor.playing ? 45 : 0;
  const audible = descriptor.audible ? 25 : 0;
  const previewPenalty =
    descriptor.width < 240 || descriptor.height < 135 || (descriptor.loop && descriptor.muted)
      ? 70
      : 0;
  const adPenalty = descriptor.likelyAdvertisement ? 100 : 0;
  return areaScore + visibility + centrality + active + audible - previewPenalty - adPenalty;
}

function isVisible(element: HTMLVideoElement, rect: DOMRect): number {
  if (rect.width <= 0 || rect.height <= 0) return 0;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (
    style?.display === "none" ||
    style?.visibility === "hidden" ||
    Number(style?.opacity ?? 1) < 0.05
  ) {
    return 0;
  }
  const viewportWidth = element.ownerDocument.documentElement.clientWidth || window.innerWidth;
  const viewportHeight = element.ownerDocument.documentElement.clientHeight || window.innerHeight;
  const overlapWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
  const overlapHeight = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
  return Math.min(1, (overlapWidth * overlapHeight) / (rect.width * rect.height));
}

function descriptorFor(element: HTMLVideoElement): PlayerDescriptor {
  const rect = element.getBoundingClientRect();
  const viewportWidth = element.ownerDocument.documentElement.clientWidth || window.innerWidth;
  const viewportHeight = element.ownerDocument.documentElement.clientHeight || window.innerHeight;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const centerDistance = Math.min(
    1,
    Math.hypot(centerX - viewportWidth / 2, centerY - viewportHeight / 2) /
      Math.hypot(viewportWidth / 2, viewportHeight / 2),
  );
  return {
    width: rect.width,
    height: rect.height,
    visibleRatio: isVisible(element, rect),
    centerDistance,
    playing: !element.paused && !element.ended,
    audible: !element.muted && element.volume > 0,
    loop: element.loop,
    muted: element.muted,
    likelyAdvertisement:
      element.closest(
        "[class*='ad-showing'],[class*='advertisement'],[data-testid*='ad-'],[aria-label*='Advertisement' i]",
      ) !== null,
  };
}

function collectOpenRoots(root: Document | ShadowRoot, output: Set<HTMLVideoElement>): void {
  root.querySelectorAll("video").forEach((video) => output.add(video));
  root.querySelectorAll("*").forEach((element) => {
    if (element.shadowRoot) collectOpenRoots(element.shadowRoot, output);
    if (element instanceof HTMLIFrameElement) {
      try {
        if (element.contentDocument) collectOpenRoots(element.contentDocument, output);
      } catch {
        // Cross-origin frames are intentionally inaccessible.
      }
    }
  });
}

export class PlayerDetector {
  private readonly ids = new WeakMap<HTMLVideoElement, string>();
  private readonly observers = new Map<Node, MutationObserver>();
  private readonly known = new Set<HTMLVideoElement>();
  private selectedId: string | undefined;
  private nextId = 1;
  private stopped = false;

  constructor(private readonly onChange: () => void) {}

  start(): void {
    this.scanRoot(document);
    this.observeRoot(document);
  }

  stop(): void {
    this.stopped = true;
    this.observers.forEach((observer) => observer.disconnect());
    this.observers.clear();
    this.known.clear();
  }

  select(id: string): boolean {
    if (!this.candidates().some((candidate) => candidate.id === id)) return false;
    this.selectedId = id;
    this.onChange();
    return true;
  }

  selectedElement(): HTMLVideoElement | undefined {
    const candidates = this.candidates();
    if (candidates.length === 0) return undefined;
    const manual = candidates.find((candidate) => candidate.id === this.selectedId);
    return (manual ?? candidates[0])?.element;
  }

  summaries(): VideoCandidateSummary[] {
    const candidates = this.candidates();
    const selected = this.selectedElement();
    return candidates.map((candidate, index) => {
      const rect = candidate.element.getBoundingClientRect();
      return {
        id: candidate.id,
        label:
          candidate.element.getAttribute("aria-label")?.slice(0, 70) ||
          candidate.element.getAttribute("title")?.slice(0, 70) ||
          `Video ${index + 1} (${Math.round(rect.width)}×${Math.round(rect.height)})`,
        score: Math.round(candidate.score),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        selected: candidate.element === selected,
      };
    });
  }

  private candidates(): Candidate[] {
    for (const element of this.known) {
      if (!element.isConnected) this.known.delete(element);
    }
    return [...this.known]
      .map((element) => ({
        id: this.idFor(element),
        element,
        score: rankPlayer(descriptorFor(element)),
      }))
      .filter(({ element }) => {
        const rect = element.getBoundingClientRect();
        return rect.width >= 80 && rect.height >= 45;
      })
      .sort((left, right) => right.score - left.score);
  }

  private idFor(element: HTMLVideoElement): string {
    const current = this.ids.get(element);
    if (current) return current;
    const id = `video-${this.nextId}`;
    this.nextId += 1;
    this.ids.set(element, id);
    return id;
  }

  private scanRoot(root: Document | ShadowRoot): void {
    const found = new Set<HTMLVideoElement>();
    collectOpenRoots(root, found);
    found.forEach((element) => {
      this.known.add(element);
      this.idFor(element);
    });
  }

  private observeRoot(root: Document | ShadowRoot): void {
    if (this.observers.has(root)) return;
    const observer = new MutationObserver((mutations) => {
      let changed = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node instanceof HTMLVideoElement) {
            this.known.add(node);
            this.idFor(node);
            changed = true;
          }
          node.querySelectorAll("video").forEach((video) => {
            this.known.add(video);
            this.idFor(video);
            changed = true;
          });
          if (node.shadowRoot) {
            this.scanRoot(node.shadowRoot);
            this.observeRoot(node.shadowRoot);
            changed = true;
          }
        }
        mutation.removedNodes.forEach((node) => {
          if (node instanceof HTMLVideoElement) changed = true;
        });
      }
      if (changed && !this.stopped) this.onChange();
    });
    observer.observe(root, { childList: true, subtree: true });
    this.observers.set(root, observer);
  }
}
