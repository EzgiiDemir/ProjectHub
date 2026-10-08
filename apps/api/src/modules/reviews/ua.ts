/** Minimal user-agent summary for feedback context ("Chrome 140 / Windows"). */
export function describeUserAgent(ua: string): { browser: string; os: string } {
  const pick = (re: RegExp) => re.exec(ua)?.[1];
  let browser = 'Bilinmeyen tarayıcı';
  const edge = pick(/Edg(?:e|A|iOS)?\/(\d+)/);
  const opera = pick(/OPR\/(\d+)/);
  const samsung = pick(/SamsungBrowser\/(\d+)/);
  const chrome = pick(/(?:Chrome|CriOS)\/(\d+)/);
  const firefox = pick(/(?:Firefox|FxiOS)\/(\d+)/);
  const safari = /Safari\//.test(ua) ? pick(/Version\/(\d+(?:\.\d+)?)/) : undefined;
  if (edge) browser = `Edge ${edge}`;
  else if (opera) browser = `Opera ${opera}`;
  else if (samsung) browser = `Samsung Internet ${samsung}`;
  else if (firefox) browser = `Firefox ${firefox}`;
  else if (chrome) browser = `Chrome ${chrome}`;
  else if (safari) browser = `Safari ${safari}`;
  let os = 'Bilinmeyen sistem';
  if (/iPhone|iPad|iPod/.test(ua)) os = `iOS ${(pick(/OS (\d+)[_.]/) ?? '').trim()}`.trim();
  else if (/Android/.test(ua)) os = `Android ${pick(/Android (\d+)/) ?? ''}`.trim();
  else if (/Windows NT/.test(ua)) os = 'Windows';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  return { browser, os };
}
