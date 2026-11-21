type Translate = (zh: string, en: string) => string;

export function rollingStatusPanel(t: Translate): string {
  return `<template x-if="dreamStatus && dreamStatus.rolling">
    <section class="panel panel-pad">
      <h2 class="h2">${t("白天整理", "Daytime Dream")}</h2>
      <p class="mt-2 text-sm muted" x-text="(dreamStatus.rolling.on ? L('已开', 'On') : L('已关', 'Off')) + ' · ' + L('待整理 ', 'Waiting ') + dreamStatus.rolling.backlog + L(' 条', ' messages')"></p>
      <p x-show="dreamStatus.rolling.active_window" class="mt-1 text-sm" x-text="L('有窗口正在处理', 'A window is running')"></p>
      <template x-if="dreamStatus.rolling.recent_windows.length">
        <div class="mt-3 space-y-1">
          <h3 class="font-semibold">${t("最近窗口", "Recent windows")}</h3>
          <template x-for="window in dreamStatus.rolling.recent_windows" :key="window.window_key">
            <p class="text-xs muted" x-text="new Date(window.finished_at).toLocaleString() + ' · Clef ' + window.clef_calls + L(' 次 · 抽取 ', ' calls · extraction ') + window.extractor_calls + L(' 次', ' calls')"></p>
          </template>
        </div>
      </template>
      <template x-if="dreamStatus.rolling.failed_windows.length">
        <div class="mt-3 space-y-1">
          <h3 class="font-semibold">${t("失败窗口", "Failed windows")}</h3>
          <template x-for="window in dreamStatus.rolling.failed_windows" :key="window.window_key">
            <p class="text-xs muted" x-text="new Date(window.finished_at).toLocaleString() + ' · ' + window.error"></p>
          </template>
        </div>
      </template>
    </section>
  </template>`;
}
