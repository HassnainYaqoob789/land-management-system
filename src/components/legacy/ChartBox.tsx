'use client';

// The reference's chart card body (<div class="chartbox"><canvas>) and its
// mkChart() defaults from legacy-demo/assets/js/ui/screens.js, on the same
// Chart.js version (4.4.0). Redraws when the light/dark theme changes.

import React, { useEffect, useRef } from 'react';
import { Chart, registerables, type ChartConfiguration } from 'chart.js';

Chart.register(...registerables);

export const PAL = { blue: '#2368b0', green: '#16a061', amber: '#e09a1a', red: '#d93a3a', purple: '#7a4fc2', teal: '#1597a6', grey: '#8a9bb0' };

function themed(cfg: ChartConfiguration): ChartConfiguration {
  const dark = document.documentElement.dataset.theme === 'dark';
  const t = dark ? '#c2cedd' : '#3e4c5e', g = dark ? '#2a3b56' : '#e6ebf2';
  const options: any = { responsive: true, maintainAspectRatio: false, ...(cfg.options || {}) };
  options.plugins = { ...(options.plugins || {}) };
  options.plugins.legend = { labels: { color: t, boxWidth: 12, font: { size: 11 } }, ...(options.plugins.legend || {}) };
  if (cfg.type !== 'doughnut' && cfg.type !== 'pie') {
    options.scales = options.scales || { x: {}, y: {} };
    for (const s of Object.values(options.scales) as any[]) {
      s.ticks = { color: t, font: { size: 10.5 }, ...(s.ticks || {}) };
      s.grid = { color: g };
      if (s.title) s.title = { color: t, ...s.title };
    }
  }
  return { ...cfg, options };
}

export default function ChartBox({ config, label, summary }: { config: ChartConfiguration; label: string; summary?: [string, string][] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    let chart = new Chart(ref.current, themed(config));
    const obs = new MutationObserver(() => { chart.destroy(); chart = new Chart(ref.current!, themed(config)); });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { obs.disconnect(); chart.destroy(); };
  }, [config]);
  return (
    <div className="chartbox">
      <canvas ref={ref} role="img" aria-label={label} />
      {summary && summary.length > 0 && (
        <table className="sr-only">
          <caption>{label}</caption>
          <tbody>
            {summary.map(([k, v], i) => (
              <tr key={i}><th>{k}</th><td>{v}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
