import { parseHTML } from 'linkedom';
import { NcellError } from '../core/index.js';

function text(root: ParentNode, selector: string): string {
  return root.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function number(value: string): number | null {
  const normalized = value.trim().replace(/^#/, '').replaceAll(',', '');
  if (!/^\d+$/.test(normalized)) return null;
  const result = Number(normalized);
  return Number.isSafeInteger(result) ? result : null;
}

/** Parse the website's leaderboard without exposing HTML or inventing absent values. */
export function parseRanks(html: string): Record<string, unknown> {
  const { document } = parseHTML(html);
  if (text(document, 'h1') !== 'Leaderboard') {
    throw new NcellError('Ncell returned an invalid leaderboard', { code: 'INVALID_RESPONSE' });
  }
  const performanceCard = [...document.querySelectorAll('.glass-card')].find((card) =>
    /\bYour Performance\b/.test(card.textContent ?? ''),
  );
  const stats = performanceCard
    ? [...performanceCard.querySelectorAll('.font-800')].map((element) =>
        number(element.textContent ?? ''),
      )
    : [];
  const performance = performanceCard
    ? {
        rank: number(text(performanceCard, '.rank-hero')),
        points: stats[0] ?? null,
        tokens: stats[1] ?? null,
        streak_days: stats[2] ?? null,
        period: text(performanceCard, '.justify-between > span:last-child'),
      }
    : null;
  const lastWeekCard = document.querySelector('.last-week-card');
  const lastWeek = lastWeekCard
    ? {
        rank: number(text(lastWeekCard, '.rank-hero-purple')),
        points: number(text(lastWeekCard, '.font-800')),
        prize: text(lastWeekCard, '.rank-hero'),
        period: text(lastWeekCard, '.justify-between > span:last-child'),
      }
    : null;
  const players = [...document.querySelectorAll('.space-y-2 > div')].flatMap((row) => {
    const rank = number(text(row, 'span.font-900'));
    if (rank === null) return [];
    return [
      {
        rank,
        number: text(row, '.truncate'),
        activity: text(row, '.text-xs.text-gray-400'),
        points: number(text(row, '.text-right .font-900')),
        is_you: rank === performance?.rank || /\b(?:you)\b/i.test(row.textContent ?? ''),
      },
    ];
  });
  const prizes = [...document.querySelectorAll('.divide-y > div')].map((row) => ({
    ranks: text(row, '.text-white.font-semibold'),
    reward: text(row, '.text-right .leading-none'),
  }));
  return {
    week: text(document, '.sticky p').split('•')[0]?.trim() ?? '',
    performance,
    last_week: lastWeek,
    prizes,
    players,
  };
}
