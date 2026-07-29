const video = document.querySelector("#main-video");
const output = document.querySelector("output");

globalThis.fixtureEvents = {
  play: 0,
  pause: 0,
  seeked: 0,
  ratechange: 0,
  waiting: 0,
  canplay: 0,
};

for (const name of Object.keys(globalThis.fixtureEvents)) {
  video?.addEventListener(name, () => {
    globalThis.fixtureEvents[name] += 1;
    if (output) {
      output.value = `${name} · t=${video.currentTime.toFixed(2)} · rate=${video.playbackRate}`;
    }
  });
}

document.querySelector("#simulate-buffer")?.addEventListener("click", () => {
  video.dispatchEvent(new Event("waiting"));
  window.setTimeout(() => video.dispatchEvent(new Event("canplay")), 2_200);
});

document.querySelector("#replace-video")?.addEventListener("click", () => {
  const replacement = video.cloneNode(true);
  replacement.currentTime = video.currentTime;
  video.replaceWith(replacement);
  history.pushState({}, "", `/spa.html?view=${Date.now()}`);
  window.dispatchEvent(new Event("wxt:locationchange"));
});
