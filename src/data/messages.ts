// Exact message strings, pixel coordinates, attributes, and default Hall of Fame from Sabre Wulf (1984)

export interface ScreenMessage {
  readonly x: number;
  readonly y: number;
  readonly attr: number;
  readonly text: string; // Supports '\x7f' for ZX Spectrum © glyph
}

export interface HighScoreEntry {
  score: [number, number, number]; // 3 BCD bytes, e.g. [0x10, 0x22, 0x75] => "102275"
  initials: string; // 3 chars
}

export const DEFAULT_HIGH_SCORES: readonly HighScoreEntry[] = [
  { score: [0x10, 0x22, 0x75], initials: "ULT" },
  { score: [0x05, 0x51, 0x50], initials: "ACG" },
  { score: [0x03, 0x78, 0x95], initials: "CTJ" },
  { score: [0x02, 0x43, 0x20], initials: "TDJ" },
  { score: [0x01, 0x27, 0x75], initials: "JSL" },
  { score: [0x00, 0x82, 0x50], initials: "CLW" },
];

export const BANNER_MESSAGES: readonly ScreenMessage[] = [
  { x: 0x10, y: 0x00, attr: 0x45, text: "1UP" },
  { x: 0x78, y: 0x00, attr: 0x57, text: "HI" },
  { x: 0xd8, y: 0x00, attr: 0x45, text: "2UP" },
];

export const GAME_MENU_LINES: readonly ScreenMessage[] = [
  { x: 0x40, y: 0x48, attr: 0x46, text: "1  1 PLAYER GAME" },
  { x: 0x40, y: 0x60, attr: 0x46, text: "2  2 PLAYER GAME" },
  { x: 0x40, y: 0x88, attr: 0x47, text: "0  START GAME" },
  { x: 0x48, y: 0xb0, attr: 0x47, text: "\x7f 1984  A.C.G." },
];

export const HALL_OF_FAME_LINES: readonly ScreenMessage[] = [
  { x: 0x28, y: 0x30, attr: 0x47, text: "ULTIMATE HALL OF FAME" },
  { x: 0x38, y: 0x48, attr: 0x47, text: "1ST               " },
  { x: 0x38, y: 0x58, attr: 0x47, text: "2ND               " },
  { x: 0x38, y: 0x68, attr: 0x46, text: "3RD               " },
  { x: 0x38, y: 0x78, attr: 0x46, text: "4TH               " },
  { x: 0x38, y: 0x88, attr: 0x45, text: "5TH               " },
  { x: 0x38, y: 0x98, attr: 0x45, text: "6TH               " },
  { x: 0x48, y: 0xb0, attr: 0x47, text: "\x7f 1984  A.C.G." },
];

export const HIGH_SCORE_SUFFIXES = [
  "6TH",
  "5TH",
  "4TH",
  "3RD",
  "2ND",
  "   ",
] as const;

export function getNewHighScoreMessages(
  playerNum: 1 | 2,
  placesBeaten: number,
): ScreenMessage[] {
  const suffix =
    HIGH_SCORE_SUFFIXES[Math.max(0, Math.min(5, placesBeaten - 1))];
  return [
    { x: 0x40, y: 0x28, attr: 0x45, text: "CONGRATULATIONS" },
    { x: 0x60, y: 0x38, attr: 0x45, text: `PLAYER ${playerNum}` },
    { x: 0x38, y: 0x48, attr: 0x45, text: "YOU HAVE ACHIEVED" },
    { x: 0x38, y: 0x58, attr: 0x45, text: `TODAYS ${suffix} HIGHEST` },
    { x: 0x68, y: 0x68, attr: 0x45, text: "SCORE" },
    { x: 0x40, y: 0x78, attr: 0x43, text: "PLEASE REGISTER" },
    { x: 0x48, y: 0x88, attr: 0x43, text: "YOUR INITIALS" },
    { x: 0x68, y: 0x98, attr: 0x47, text: "- - -" },
  ];
}

export const POEMS: readonly (readonly ScreenMessage[])[] = [
  // Poem 1 ($A055)
  [
    { x: 0x20, y: 0x80, attr: 0x47, text: "ONE PIECE IS ALL THAT YOU" },
    { x: 0x58, y: 0x90, attr: 0x47, text: "HAVE FOUND" },
    { x: 0x28, y: 0xa0, attr: 0x45, text: "COLLECT THREE MORE AND" },
    { x: 0x48, y: 0xb0, attr: 0x45, text: "OUTWARD BOUND" },
  ],
  // Poem 2 ($A0A7)
  [
    { x: 0x18, y: 0x80, attr: 0x47, text: "TWO PIECES FOUND ARE YOURS" },
    { x: 0x60, y: 0x90, attr: 0x47, text: "TO KEEP" },
    { x: 0x20, y: 0xa0, attr: 0x45, text: "THIS SCORE AGAIN IS WHAT" },
    { x: 0x60, y: 0xb0, attr: 0x45, text: "YOU SEEK" },
  ],
  // Poem 3 ($A0F4)
  [
    { x: 0x38, y: 0x80, attr: 0x47, text: "ONE PIECE MORE MUST" },
    { x: 0x60, y: 0x90, attr: 0x47, text: "YOU AMASS" },
    { x: 0x28, y: 0xa0, attr: 0x45, text: "AND FIND THE KEEPER YOU" },
    { x: 0x60, y: 0xb0, attr: 0x45, text: "MAY PASS" },
  ],
  // Poem 4 ($A13B)
  [
    { x: 0x18, y: 0x80, attr: 0x47, text: "FOUR PIECES FOUND HAVE NOW" },
    { x: 0x58, y: 0x90, attr: 0x47, text: "MADE WHOLE" },
    { x: 0x20, y: 0xa0, attr: 0x45, text: "TO FIND THE CAVE MUST BE" },
    { x: 0x58, y: 0xb0, attr: 0x45, text: "YOUR GOAL" },
  ],
];

export const GAME_COMPLETE_MESSAGES: readonly ScreenMessage[] = [
  { x: 0x60, y: 0x20, attr: 0x47, text: "THE NEXT" },
  { x: 0x28, y: 0x30, attr: 0x47, text: "ADVENTURES OF SABRE MAN" },
  { x: 0x20, y: 0x40, attr: 0x47, text: "WILL BE CONTINUED IN THE" },
  { x: 0x10, y: 0x88, attr: 0x45, text: "THE UNDER-WURLDE \x7f COPYRIGHT" },
  { x: 0x48, y: 0x98, attr: 0x45, text: "1984 A.C.G. LTD." },
  { x: 0x30, y: 0xa8, attr: 0x45, text: "-ALL RIGHTS RESERVED-" },
];

export function getGameOverMessages(playerNum: 1 | 2): ScreenMessage[] {
  return [
    { x: 0x20, y: 0x78, attr: 0x47, text: "ADVENTURE COMPLETED    %" },
    { x: 0x38, y: 0x60, attr: 0x47, text: `GAME OVER PLAYER ${playerNum}` },
  ];
}
