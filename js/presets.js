// Built-in fires. Values are 0–1 for each control in the tuning sheet.
export const CONTROLS = [
  { key: 'size', label: 'Fire', low: 'Embers', high: 'Bonfire' },
  { key: 'crackle', label: 'Crackle', low: 'Hushed', high: 'Lively' },
  { key: 'pops', label: 'Pops', low: 'Rare', high: 'Frequent' },
  { key: 'warmth', label: 'Warmth', low: 'Airy', high: 'Cozy' },
  { key: 'distance', label: 'Distance', low: 'Toes warm', high: 'Across camp' },
  { key: 'wind', label: 'Breeze', low: 'Still', high: 'Breezy' },
];

export const PRESETS = [
  {
    id: 'embers', name: 'Glowing Embers', blurb: 'Soft, low, and nearly asleep itself',
    params: { size: 0.1, crackle: 0.22, pops: 0.06, warmth: 0.8, distance: 0.2, wind: 0 },
  },
  {
    id: 'hearth', name: 'Cabin Hearth', blurb: 'A steady fireplace on a quiet night',
    params: { size: 0.42, crackle: 0.42, pops: 0.25, warmth: 0.78, distance: 0.32, wind: 0 },
  },
  {
    id: 'stories', name: 'Campfire Stories', blurb: 'A lively wood fire under the stars',
    params: { size: 0.64, crackle: 0.62, pops: 0.45, warmth: 0.5, distance: 0.25, wind: 0.22 },
  },
  {
    id: 'bonfire', name: 'Big Bonfire', blurb: 'Tall flames, deep roar, plenty of snap',
    params: { size: 0.95, crackle: 0.68, pops: 0.55, warmth: 0.6, distance: 0.5, wind: 0.12 },
  },
  {
    id: 'cove', name: 'Driftwood Cove', blurb: 'A beach fire heard from your blanket, breeze off the water',
    params: { size: 0.55, crackle: 0.45, pops: 0.32, warmth: 0.45, distance: 0.72, wind: 0.55 },
  },
];
