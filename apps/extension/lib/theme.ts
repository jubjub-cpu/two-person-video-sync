import type { ThemeMode } from "./types";

export function applyThemeMode(
  mode: ThemeMode,
  root: HTMLElement = document.documentElement,
): void {
  if (mode === "system") {
    root.removeAttribute("data-theme");
    root.style.colorScheme = "light dark";
    return;
  }

  root.dataset.theme = mode;
  root.style.colorScheme = mode;
}
