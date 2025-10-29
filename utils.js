// Email validation regex
export const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Define intents for detection
export const intents = [
  'saveEmail',
  'removeEmail',
  'sendEmail',
  'listEmails',
  'dateQuery',
  'unknown'
];

export function detectIntent(prompt) {
  const lowerPrompt = prompt.toLowerCase();
  let intent = 'unknown';
  let score = 0;

  if (lowerPrompt.includes('save') || lowerPrompt.includes('add') || lowerPrompt.includes('store') || lowerPrompt.includes('set')) {
    intent = 'saveEmail';
    score = 2 + (lowerPrompt.includes('=') ? 1 : 0);
  } else if (lowerPrompt.includes('remove') || lowerPrompt.includes('delete')) {
    intent = 'removeEmail';
    score = 2;
  } else if (lowerPrompt.includes('send') && lowerPrompt.includes('email')) {
    intent = 'sendEmail';
    score = 3 + (lowerPrompt.includes('to') ? 1 : 0);
  } else if (lowerPrompt.includes('list') || lowerPrompt.includes('show')) {
    intent = 'listEmails';
    score = 2;
  } else if (lowerPrompt.includes('date') && lowerPrompt.includes('today')) {
    intent = 'dateQuery';
    score = 2;
  }

  return { intent, score, correctedTokens: [], correctedPrompt: prompt };
}

export async function getSavedAliasesMap(db) {
  const rows = await db.all('SELECT alias, email FROM emails');
  const map = new Map();
  rows.forEach(row => map.set(row.alias.toLowerCase(), row.email));
  return map;
}

export async function getClosestAlias(alias, db) {
  const rows = await db.all('SELECT alias FROM emails');
  const aliases = rows.map(row => row.alias.toLowerCase());
  let minDistance = Infinity;
  let closest = null;
  for (const savedAlias of aliases) {
    const distance = simpleLevenshtein(alias.toLowerCase(), savedAlias);
    if (distance < minDistance && distance <= 2) {
      minDistance = distance;
      closest = savedAlias;
    }
  }
  return closest;
}

export async function resolveAliasesToEmails(aliases, savedMap, replyFn, db) {
  const resolved = [];
  for (const alias of aliases) {
    if (alias === 'everyone') {
      const allRows = await db.all('SELECT alias, email FROM emails');
      resolved.push(...allRows.map(row => ({ alias: row.alias, email: row.email })));
    } else {
      const email = savedMap.get(alias.toLowerCase());
      if (email) {
        resolved.push({ alias, email });
      } else {
        const closest = await getClosestAlias(alias, db);
        if (closest) {
          await replyFn(`Assuming '${closest}' for '${alias}'.`);
          const closestEmail = savedMap.get(closest.toLowerCase());
          resolved.push({ alias: closest, email: closestEmail });
        }
      }
    }
  }
  return resolved;
}

function simpleLevenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array(m + 1).fill().map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(dp[i - 1][j - 1] + 1, dp[i][j - 1] + 1, dp[i - 1][j] + 1);
      }
    }
  }
  return dp[m][n];
}