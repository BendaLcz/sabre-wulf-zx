import {
  TUNE_GAME_OVER,
  TUNE_MAIN,
  TUNE_POEM,
  TUNE_STARTUP,
} from "../data/audioData";
import { BACKGROUNDS } from "../data/backgrounds";
import { LOADING_SCREEN_SCR } from "../data/loadingScreen";
import {
  BANNER_MESSAGES,
  DEFAULT_HIGH_SCORES,
  GAME_COMPLETE_MESSAGES,
  GAME_MENU_LINES,
  getGameOverMessages,
  getNewHighScoreMessages,
  HALL_OF_FAME_LINES,
  HighScoreEntry,
  POEMS,
} from "../data/messages";
import {
  AMULET_DISPLAY_STAMPS,
  AMULET_ROOM_SETS,
  INITIAL_ACTORS_DATA,
  INITIAL_ORCHID_STATES,
  JUNGLE_LAYOUT,
  OBJECT_LOCATIONS,
  ROOM_COMPLETE,
  ROOM_MAIN_MENU,
  ROOM_TEMPLATES,
  RoomStamp,
} from "../data/rooms";
import { UDG_LIFE } from "../data/sprites";
import { ROM_NOISE } from "../data/zxFont";
import { ZXBeeper } from "../zx/beeper";
import {
  ControlMethod,
  CTRL_FIRE,
  CTRL_LEFT,
  CTRL_RIGHT,
  ZXInput,
} from "../zx/input";
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  ZX_BORDER,
  ZXScreen,
} from "../zx/zxScreen";
import {
  countAmuletPieces,
  drawActorsInRoom,
  loadOrchidForRoom,
  markRoomVisited,
  saveOrchidState,
  setUpRoomObjects,
  stepActorSlot,
  trySpawnFlame,
  trySpawnNastie,
  WorldCallbacks,
} from "./actors";
import {
  compareBcdScores,
  computeAdventurePercentage,
  formatBcdScore,
} from "./physics";
import {
  createBlankPlayerWorld,
  createEmptyActor,
  GamePhase,
  MapSnapshot,
  NUM_ACTORS,
  PlayerWorldState,
  SLOT_AMULET_FIRST,
  SLOT_PLAYER,
} from "./types";

const HOF_STORAGE_KEY = "sabrewulf_hall_of_fame_v1";

export interface ExternalUiHooks {
  isStandaloneApp: () => boolean;
  canFullscreen: () => boolean;
  isFullscreen: () => boolean;
  toggleFullscreen: () => void;
  isCrtEnabled: () => boolean;
  toggleCrt: () => void;
  toggleMute: () => void;
  quitApp: () => void;
}

type MobileMenuSubScreen = "MAIN" | "OPTIONS" | "QUIT_PROMPT";

interface MobileMenuItem {
  readonly y: number;
  readonly attr: number;
  readonly text: string;
  readonly action: () => void;
}

export class SabreWulfGame {
  public readonly screen: ZXScreen;
  public readonly beeper: ZXBeeper;
  public readonly input: ZXInput;

  private phase: GamePhase = "LOADING";
  private twoPlayers = false;
  private readonly controlMethod: ControlMethod = ControlMethod.KEYBOARD;

  private players: [PlayerWorldState, PlayerWorldState] = [
    createBlankPlayerWorld(),
    createBlankPlayerWorld(),
  ];
  private activePlayerIdx: 0 | 1 = 0;

  private highScores: HighScoreEntry[] = [];
  private hallOfFameUpdated = false;

  // Global Z80 system & game timers ($5C78, $9693..$96B9)
  private framesCounter = 0;
  private gameTimer = 0;
  private randomSeed = 0x5a;
  private rReg = 0x17;
  private savedActorIndex = 1; // 1..24 round-robin across frames
  private actorCycleBudgetT = 0;

  private gameDelayTimer = 0; // $96B5
  private orchidEffectTimer = 0; // $96B0
  private nastieSpawnDelay = 0; // $96B1
  private flameSpawnDelay = 0; // $96B4

  private menuIdleTimer = 0x0300;
  private menuAwaitKeyRelease = false;
  private menuSubScreen: MobileMenuSubScreen = "MAIN";
  private uiHooks: ExternalUiHooks | null = null;
  private phaseWaitFrames = 0;
  private hofReturnToMenu = true;
  private pauseBorderPhase = 0;
  private uiPaused = false;

  // High-score initial entry state ($B5FC..$B742)
  private pendingHighScoreQueue: (0 | 1)[] = [];
  private currentInitialSlotIdx = 0;
  private currentInitialCharIndex = 0; // 0..2
  private currentInitialAscii = 0x20; // ' ' or 'A'..'Z'
  private initialInputCooldown = 0;
  private waitingFireRelease = false;

  private readonly callbacks: WorldCallbacks;

  constructor(canvas: HTMLCanvasElement) {
    this.screen = new ZXScreen(canvas);
    this.beeper = new ZXBeeper();
    this.input = new ZXInput();
    this.highScores = this.loadHighScores();

    this.callbacks = {
      screen: this.screen,
      beeper: this.beeper,
      getFrames: () => this.framesCounter,
      getGameTimer: () => this.gameTimer,
      nextRandom: () => this.advanceRandom(),
      peekRandom: () => this.randomSeed,
      readControls: () => this.input.readControls(this.controlMethod),
      getGameDelayTimer: () => this.gameDelayTimer,
      setGameDelayTimer: (val) => {
        this.gameDelayTimer = val & 0xff;
      },
      getOrchidTimer: () => this.orchidEffectTimer,
      setOrchidTimer: (val) => {
        this.orchidEffectTimer = val & 0xff;
      },
      getNastieSpawnDelay: () => this.nastieSpawnDelay,
      setNastieSpawnDelay: (val) => {
        this.nastieSpawnDelay = val & 0xff;
      },
      getFlameSpawnDelay: () => this.flameSpawnDelay,
      setFlameSpawnDelay: (val) => {
        this.flameSpawnDelay = val & 0xff;
      },
      getActivePlayerIndex: () => this.activePlayerIdx,
      onScoreChanged: () => this.drawScores(),
      onLivesChanged: () => this.drawLives(),
      onShowAmulet: () => this.enterShowAmuletPhase(),
      onGameComplete: () => this.enterGameCompletePhase(),
      onPlayerTurnEnded: () => this.handlePlayerTurnEnded(),
      drawCurrentRoom: (prevRoom) => this.drawCurrentRoom(prevRoom, false),
    };

    this.enterLoadingScreen();

    const mobileLayoutQuery = window.matchMedia?.(
      "(pointer: coarse), (max-width: 760px)",
    );
    mobileLayoutQuery?.addEventListener?.("change", () => {
      if (this.phase === "MENU") {
        this.menuSubScreen = "MAIN";
        this.drawMenuLines();
      } else if (this.phase === "HALL_OF_FAME") {
        this.drawHallOfFameScreen();
      }
    });
  }

  public setExternalUiHooks(hooks: ExternalUiHooks): void {
    this.uiHooks = hooks;
    this.refreshMenuIfActive();
  }

  public refreshMenuIfActive(): void {
    if (this.phase === "MENU") {
      this.drawMenuLines();
    }
  }

  private isMobileMenuLayout(): boolean {
    return Boolean(
      window.matchMedia?.("(pointer: coarse), (max-width: 760px)")?.matches,
    );
  }

  public getPhase(): GamePhase {
    return this.phase;
  }

  public setTwoPlayers(two: boolean): void {
    this.twoPlayers = two;
    if (this.phase === "MENU") {
      this.menuIdleTimer = 0x0300;
      this.drawMenuLines();
    }
  }

  public isTwoPlayers(): boolean {
    return this.twoPlayers;
  }

  public resetHighScores(): void {
    this.highScores = DEFAULT_HIGH_SCORES.map((e) => ({
      score: [...e.score] as [number, number, number],
      initials: e.initials,
    }));
    try {
      localStorage.removeItem(HOF_STORAGE_KEY);
    } catch {
      // Ignore storage errors
    }
    this.drawScores();
    if (this.phase === "HALL_OF_FAME") {
      this.drawHallOfFameScreen();
    }
  }

  /** Trigger start/advance from UI button or canvas tap */
  public triggerPrimaryAction(): void {
    this.beeper.unlock();
    if (this.phase === "LOADING") {
      this.enterMenu();
    } else if (this.phase === "MENU") {
      this.startNewGame();
    } else if (this.phase === "HALL_OF_FAME") {
      this.finishHallOfFame();
    }
  }

  /**
   * Handle a tap on the display. fx/fy are the tap position as fractions (0..1) of the canvas.
   * In the menu, taps select 1/2 player or start the game.
   */
  public handleScreenTap(fx: number, fy: number): void {
    this.beeper.unlock();
    if (this.phase === "LOADING") {
      this.triggerPrimaryAction();
      return;
    }

    const x = fx * CANVAS_WIDTH - ZX_BORDER;
    const y = fy * CANVAS_HEIGHT - ZX_BORDER;

    if (this.phase === "HALL_OF_FAME") {
      if (!this.isMobileMenuLayout()) {
        this.triggerPrimaryAction();
      } else if (x >= 32 && x < 224 && y >= 0x8e && y < 0xac) {
        this.beeper.playLowTone();
        this.finishHallOfFame();
      }
      return;
    }

    if (x < 0 || x >= 256 || y < 0) return;

    if (this.phase === "ENTER_INITIALS") {
      if (y >= 0x8c && y < 0xac) {
        if (x >= 0x48 && x < 0x64) {
          this.stepInitialLetter(-1);
        } else if (x >= 0x64 && x < 0x94) {
          this.confirmInitialLetter();
        } else if (x >= 0x94 && x < 0xb0) {
          this.stepInitialLetter(1);
        }
      }
      return;
    }

    if (this.phase !== "MENU") return;

    if (this.isMobileMenuLayout()) {
      this.handleMobileMenuTap(x, y);
      return;
    }

    if (y >= 0x40 && y < 0x58) {
      this.selectPlayers(false);
    } else if (y >= 0x58 && y < 0x74) {
      this.selectPlayers(true);
    } else if (y >= 0x7c && y < 0xa0) {
      this.beeper.stopTune();
      this.startNewGame();
    }
  }

  private selectPlayers(two: boolean): void {
    this.beeper.stopTune();
    if (this.twoPlayers === two) return;
    this.twoPlayers = two;
    this.menuIdleTimer = 0x0300;
    this.drawMenuLines();
  }

  public setUiPaused(paused: boolean): void {
    this.uiPaused = paused;
    this.input.setPaused(paused);
    this.beeper.setPaused(paused);
  }

  public returnToMenu(): void {
    this.uiPaused = false;
    this.beeper.stopTune();
    this.beeper.setPaused(false);
    this.input.setPaused(false);
    this.screen.borderColour = 0;
    this.enterMenu();
  }

  public getMapSnapshot(): MapSnapshot {
    const world = this.players[this.activePlayerIdx];
    const player = world.actors[SLOT_PLAYER];
    const amuletRooms: { room: number; collected: boolean }[] = [];
    for (let i = 0; i < 4; i++) {
      const a = world.actors[SLOT_AMULET_FIRST + i];
      amuletRooms.push({
        room: a.room,
        collected: a.spriteId === 0,
      });
    }
    return {
      isPlaying:
        this.phase === "PLAYING" ||
        this.phase === "STARTUP_TUNE" ||
        this.phase === "SHOW_AMULET" ||
        this.phase === "GAME_COMPLETE",
      phase: this.phase,
      activePlayer: (this.activePlayerIdx + 1) as 1 | 2,
      playerRoom: player.room,
      visitedRooms: world.visitedRooms,
      amuletMask: player.amuletFlags & 0x0f,
      amuletRooms,
      percentage: computeAdventurePercentage(
        world.visitedRooms,
        player.amuletFlags,
      ),
      orchidColour: player.colour,
      orchidTimer: this.orchidEffectTimer,
    };
  }

  /** Advance one 50 Hz ZX Spectrum frame (20 ms) */
  public stepFrame(): void {
    this.framesCounter = (this.framesCounter + 1) & 0xffff;
    this.rReg = (this.rReg + 13) & 0x7f;
    this.advanceRandom();
    this.screen.tickFlash();

    let borderOverride: number | undefined;

    switch (this.phase) {
      case "LOADING": {
        if (this.input.isAnyKeyDown()) {
          this.beeper.unlock();
          this.input.clearJustPressed();
          this.enterMenu();
        }
        break;
      }

      case "MENU": {
        this.updateMenuFrame();
        break;
      }

      case "HALL_OF_FAME": {
        if (this.isMobileMenuLayout()) {
          // On mobile, stay on Hall of Fame until 'BACK TO MENU' is tapped
          break;
        }
        if (this.phaseWaitFrames > 0) this.phaseWaitFrames--;
        if (this.input.isAnyKeyDown() || this.phaseWaitFrames <= 0) {
          if (this.phaseWaitFrames < 580 || !this.hofReturnToMenu) {
            // Brief debounce so menu key doesn't immediately dismiss
            this.input.clearJustPressed();
            this.finishHallOfFame();
          }
        }
        break;
      }

      case "STARTUP_TUNE": {
        borderOverride = this.handlePauseFrame();
        if (borderOverride !== undefined) break;
        if (this.phaseWaitFrames > 0) this.phaseWaitFrames--;
        if (!this.beeper.isPlayingTune() && this.phaseWaitFrames <= 0) {
          this.phase = "PLAYING";
        }
        break;
      }

      case "PLAYING": {
        borderOverride = this.handlePauseFrame();
        if (borderOverride !== undefined) break;
        this.stepGameplayFrame();
        break;
      }

      case "SHOW_AMULET": {
        borderOverride = this.handlePauseFrame();
        if (borderOverride !== undefined) break;
        if (this.phaseWaitFrames > 0) this.phaseWaitFrames--;
        if (!this.beeper.isPlayingTune() && this.phaseWaitFrames <= 0) {
          this.phase = "PLAYING";
          this.drawCurrentRoom(null, true);
        }
        break;
      }

      case "GAME_COMPLETE": {
        if (this.phaseWaitFrames > 0) this.phaseWaitFrames--;
        if (!this.beeper.isPlayingTune() && this.phaseWaitFrames <= 0) {
          // $9F87-$9F8E: set current player's lives to 0, update HUD, and end game!
          const world = this.players[this.activePlayerIdx];
          world.lives = 0;
          this.drawLives();
          this.handlePlayerTurnEnded();
        }
        break;
      }

      case "GAME_OVER": {
        if (this.phaseWaitFrames > 0) this.phaseWaitFrames--;
        if (!this.beeper.isPlayingTune() && this.phaseWaitFrames <= 0) {
          this.afterGameOverScreen();
        }
        break;
      }

      case "ENTER_INITIALS": {
        this.stepEnterInitialsFrame();
        break;
      }
    }

    this.input.clearJustPressed();
    this.screen.render(borderOverride);
  }

  // ==========================================================================
  // SCREEN & WORLD SETUP
  // ==========================================================================

  private enterLoadingScreen(): void {
    this.phase = "LOADING";
    this.screen.borderColour = 0;
    this.screen.loadScr(LOADING_SCREEN_SCR);
    this.screen.render();
  }

  private initBannerAndScores(): void {
    this.screen.initScreenAndBannerAttrs();
    for (const msg of BANNER_MESSAGES) {
      this.screen.printColourString(msg.x, msg.y, msg.attr, msg.text);
    }
    this.drawScores();
    this.drawLives();
  }

  private drawScores(): void {
    this.printScoreAtCol(this.players[0].scoreBcd, 1);
    this.printScoreAtCol(this.highScores[0].score, 13);
    this.printScoreAtCol(this.players[1].scoreBcd, 25);
  }

  private printScoreAtCol(
    bcd: readonly [number, number, number],
    startCol: number,
  ): void {
    const str = formatBcdScore(bcd);
    for (let i = 0; i < 6; i++) {
      this.screen.printCharAtCol(str.charCodeAt(i), startCol + i, 8);
    }
  }

  private drawLives(): void {
    this.drawSinglePlayerLives(this.players[0].lives, 8);
    this.drawSinglePlayerLives(this.players[1].lives, 22);
  }

  private drawSinglePlayerLives(lives: number, col: number): void {
    if (lives <= 0) {
      this.screen.printCharAtCol(0x20, col, 0);
      this.screen.printCharAtCol(0x20, col + 1, 0);
      return;
    }
    const clamped = Math.min(9, lives);
    this.screen.printCharAtCol(0x30 + clamped, col, 0);
    this.screen.printGlyph(UDG_LIFE, 0, col + 1, 0);
  }

  private drawStampList(stamps: readonly RoomStamp[]): void {
    for (const st of stamps) {
      this.screen.drawStamp(BACKGROUNDS[st.bg], st.x, st.y, false);
    }
  }

  private enterMenu(): void {
    this.phase = "MENU";
    this.menuSubScreen = "MAIN";
    this.input.setPaused(false);
    this.players[0].lives = 0;
    this.players[1].lives = 0;
    this.initBannerAndScores();
    this.screen.clearPlayArea();
    this.drawStampList(ROOM_MAIN_MENU);
    this.drawMenuLines();
    this.menuIdleTimer = 0x0300;
    // The key that opened the menu may still be held; it must not cut the music short
    this.menuAwaitKeyRelease = this.input.isAnyKeyDown();
    this.beeper.playTune(TUNE_MAIN);
  }

  private printCenteredLine(yPx: number, attr: number, text: string): void {
    const xPx = Math.max(0, (256 - text.length * 8) >> 1);
    this.screen.printColourString(xPx, yPx, attr, text);
  }

  private getMobileMenuItems(): MobileMenuItem[] {
    const standalone = Boolean(this.uiHooks?.isStandaloneApp());
    const showFullscreen =
      !standalone && Boolean(this.uiHooks?.canFullscreen());

    if (this.menuSubScreen === "QUIT_PROMPT") {
      return [
        {
          y: 0x90,
          attr: 0x47,
          text: "BACK TO MENU",
          action: () => {
            this.beeper.playLowTone();
            this.menuSubScreen = "MAIN";
            this.drawMenuLines();
          },
        },
      ];
    }

    if (this.menuSubScreen === "OPTIONS") {
      const soundOn = !this.beeper.isMuted();
      const crtOn = Boolean(this.uiHooks?.isCrtEnabled());
      const fsOn = Boolean(this.uiHooks?.isFullscreen());
      const rows = showFullscreen
        ? [0x30, 0x48, 0x60, 0x78, 0x98]
        : [0x38, 0x50, 0x68, 0x90];
      let r = 0;

      const items: MobileMenuItem[] = [
        {
          y: rows[r++],
          attr: 0x45,
          text: this.twoPlayers ? "GAME: 2 PLAYERS" : "GAME: 1 PLAYER",
          action: () => {
            this.twoPlayers = !this.twoPlayers;
            this.beeper.playHighTone();
            this.drawMenuLines();
          },
        },
        {
          y: rows[r++],
          attr: 0x45,
          text: soundOn ? "SOUND: ON" : "SOUND: OFF",
          action: () => {
            this.uiHooks?.toggleMute();
            if (!this.beeper.isMuted()) {
              this.beeper.playHighTone();
            }
            this.drawMenuLines();
          },
        },
        {
          y: rows[r++],
          attr: 0x45,
          text: crtOn ? "CRT: ON" : "CRT: OFF",
          action: () => {
            this.uiHooks?.toggleCrt();
            this.beeper.playHighTone();
            this.drawMenuLines();
          },
        },
      ];

      if (showFullscreen) {
        items.push({
          y: rows[r++],
          attr: 0x45,
          text: fsOn ? "FULLSCREEN: ON" : "FULLSCREEN: OFF",
          action: () => {
            this.uiHooks?.toggleFullscreen();
            this.beeper.playHighTone();
            this.drawMenuLines();
          },
        });
      }

      items.push({
        y: rows[r++],
        attr: 0x47,
        text: "BACK TO MENU",
        action: () => {
          this.beeper.playLowTone();
          this.menuSubScreen = "MAIN";
          this.drawMenuLines();
        },
      });
      return items;
    }

    // Top-level mobile Main Menu ("MAIN")
    if (standalone) {
      return [
        {
          y: 0x40,
          attr: 0x46,
          text: "START GAME",
          action: () => {
            this.beeper.stopTune();
            this.startNewGame();
          },
        },
        {
          y: 0x58,
          attr: 0x45,
          text: "HALL OF FAME",
          action: () => {
            this.beeper.playLowTone();
            this.enterHallOfFame(true);
          },
        },
        {
          y: 0x70,
          attr: 0x45,
          text: "OPTIONS",
          action: () => {
            this.beeper.playLowTone();
            this.menuSubScreen = "OPTIONS";
            this.drawMenuLines();
          },
        },
        {
          y: 0x88,
          attr: 0x47,
          text: "QUIT",
          action: () => {
            this.beeper.stopTune();
            this.menuSubScreen = "QUIT_PROMPT";
            this.drawMenuLines();
            this.uiHooks?.quitApp();
          },
        },
      ];
    }

    return [
      {
        y: 0x40,
        attr: 0x46,
        text: "START GAME",
        action: () => {
          this.beeper.stopTune();
          this.startNewGame();
        },
      },
      {
        y: 0x60,
        attr: 0x45,
        text: "HALL OF FAME",
        action: () => {
          this.beeper.playLowTone();
          this.enterHallOfFame(true);
        },
      },
      {
        y: 0x80,
        attr: 0x45,
        text: "OPTIONS",
        action: () => {
          this.beeper.playLowTone();
          this.menuSubScreen = "OPTIONS";
          this.drawMenuLines();
        },
      },
    ];
  }

  private handleMobileMenuTap(x: number, y: number): void {
    if (x < 32 || x >= 224) return;
    const items = this.getMobileMenuItems();
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const topY =
        i === 0 ? item.y - 12 : (items[i - 1].y + 8 + item.y) >> 1;
      const botY =
        i === items.length - 1
          ? item.y + 20
          : (item.y + 8 + items[i + 1].y) >> 1;
      if (y >= topY && y < botY) {
        item.action();
        return;
      }
    }
  }

  private drawMenuLines(): void {
    this.screen.clearPanel();
    if (this.isMobileMenuLayout()) {
      if (this.menuSubScreen === "QUIT_PROMPT") {
        this.printCenteredLine(0x50, 0x46, "THANK YOU FOR PLAYING");
        this.printCenteredLine(0x68, 0x45, "SWIPE HOME TO CLOSE");
      }
      for (const item of this.getMobileMenuItems()) {
        this.printCenteredLine(item.y, item.attr, item.text);
      }
      this.printCenteredLine(0xb0, 0x47, "\x7f 1984  A.C.G.");
      return;
    }

    for (let i = 0; i < GAME_MENU_LINES.length; i++) {
      const line = GAME_MENU_LINES[i];
      let attr = line.attr;
      // Flash active player count (0 or 1) ($B44B-$B462)
      if (i === (this.twoPlayers ? 1 : 0)) attr |= 0x80;
      this.screen.printColourString(line.x, line.y, attr, line.text);
    }
  }

  private updateMenuFrame(): void {
    if (this.isMobileMenuLayout()) {
      return;
    }
    let changed = false;

    if (this.input.isDigitDown(1)) {
      if (this.twoPlayers) changed = true;
      this.twoPlayers = false;
      this.beeper.stopTune();
    }
    if (this.input.isDigitDown(2)) {
      if (!this.twoPlayers) changed = true;
      this.twoPlayers = true;
      this.beeper.stopTune();
    }

    if (
      this.input.isDigitDown(0) ||
      this.input.consumeJustPressed("Enter") ||
      this.input.consumeJustPressed("Space")
    ) {
      this.beeper.unlock();
      this.beeper.stopTune();
      this.startNewGame();
      return;
    }

    // Any other key stops the menu music ($BD5A)
    if (this.menuAwaitKeyRelease) {
      if (!this.input.isAnyKeyDown()) this.menuAwaitKeyRelease = false;
    } else if (this.beeper.isPlayingTune() && this.input.isAnyKeyDown()) {
      this.beeper.stopTune();
    }

    if (changed) {
      this.beeper.unlock();
      this.menuIdleTimer = 0x0300;
      this.drawMenuLines();
      return;
    }

    if (!this.beeper.isPlayingTune()) {
      this.menuIdleTimer--;
      if (this.menuIdleTimer <= 0) {
        this.enterHallOfFame(true);
      }
    }
  }

  private enterHallOfFame(returnToMenu: boolean): void {
    this.phase = "HALL_OF_FAME";
    this.hofReturnToMenu = returnToMenu;
    this.phaseWaitFrames = 600; // ~12 seconds
    this.drawHallOfFameScreen();
  }

  private drawHallOfFameScreen(): void {
    this.screen.clearPlayArea();
    this.drawStampList(ROOM_MAIN_MENU);
    this.screen.clearPanel();

    const mobile = this.isMobileMenuLayout();
    const entryCount = mobile ? 5 : 6;

    if (mobile) {
      this.printCenteredLine(0x30, 0x47, "ULTIMATE HALL OF FAME");
      for (let i = 1; i <= entryCount; i++) {
        const line = HALL_OF_FAME_LINES[i];
        this.screen.printColourString(line.x, line.y, line.attr, line.text);
      }
      this.printCenteredLine(0x98, 0x47, "BACK TO MENU");
      this.printCenteredLine(0xb0, 0x47, "\x7f 1984  A.C.G.");
    } else {
      for (const line of HALL_OF_FAME_LINES) {
        this.screen.printColourString(line.x, line.y, line.attr, line.text);
      }
    }

    // Print top BCD scores + initials starting at (X=$68 => col 13, Y=$48, step +$10) ($B2B7-$B2D5)
    let yPx = 0x48;
    for (let i = 0; i < entryCount; i++) {
      const entry = this.highScores[i];
      const str = formatBcdScore(entry.score);
      let col = 0x68 >> 3;
      for (let d = 0; d < 6; d++) {
        this.screen.printCharAtCol(str.charCodeAt(d), col++, yPx);
      }
      col += 3; // 3 spaces gap ($B2C4-$B2C6)
      for (let c = 0; c < 3; c++) {
        this.screen.printCharAtCol(
          entry.initials.charCodeAt(c) || 0x20,
          col++,
          yPx,
        );
      }
      yPx += 0x10;
    }
  }

  private finishHallOfFame(): void {
    if (this.hofReturnToMenu) {
      this.menuSubScreen = "MAIN";
      this.screen.clearPlayArea();
      this.drawStampList(ROOM_MAIN_MENU);
      this.drawMenuLines();
      this.phase = "MENU";
      this.menuIdleTimer = 0x0300;
      if (!this.isMobileMenuLayout()) {
        this.beeper.playTune(TUNE_MAIN);
      }
    } else {
      this.enterMenu();
    }
  }

  // ==========================================================================
  // GAME INITIALIZATION & TURN MANAGEMENT ($B1B7-$B25D)
  // ==========================================================================

  private handlePauseFrame(): number | undefined {
    if (!this.uiPaused && !this.input.isPaused()) {
      this.beeper.setPaused(false);
      return undefined;
    }
    if (!this.uiPaused && this.input.checkAnyKeyUnpause()) {
      this.beeper.setPaused(false);
      return undefined;
    }
    this.beeper.setPaused(true);
    // $AC47-$AC51: border alternates between Blue (1) and Magenta (3) while paused!
    this.pauseBorderPhase = (this.pauseBorderPhase + 4) & 0xff;
    return (((this.pauseBorderPhase << 2) >>> 8) & 0x02) | 0x01;
  }

  private startNewGame(): void {
    this.players = [createBlankPlayerWorld(), createBlankPlayerWorld()];
    this.activePlayerIdx = 0;
    this.uiPaused = false;
    this.input.setPaused(false);
    this.beeper.setPaused(false);

    // Clear scores & HUD ($B1B7-$B1D3)
    this.players[0].scoreBcd = [0, 0, 0];
    this.players[1].scoreBcd = [0, 0, 0];
    // Reset banner label flash bits
    for (let c = 0; c < 32; c++) {
      this.screen.attrs[c] &= 0x7f;
    }

    this.initialisePlayerWorld(this.players[0]);
    if (this.twoPlayers) {
      this.initialisePlayerWorld(this.players[1]);
    }

    this.drawScores();
    this.beginPlayerTurn(true);
  }

  private initialisePlayerWorld(world: PlayerWorldState): void {
    world.lives = 5; // $B21E (1 consumed immediately on StartTurn => 4 spare lives shown)
    world.nastieLimit = 3;
    world.facingRight = false;
    world.visitedRooms.fill(0);
    world.orchidStates.set(INITIAL_ORCHID_STATES);

    for (let i = 0; i < NUM_ACTORS; i++) {
      world.actors[i] = createEmptyActor();
    }

    // Copy initial 12 actors from $AC77 ($AC6B)
    for (let i = 0; i < 12; i++) {
      const base = i * 12;
      const a = world.actors[i];
      a.spriteId = INITIAL_ACTORS_DATA[base];
      a.room = INITIAL_ACTORS_DATA[base + 1];
      a.state = INITIAL_ACTORS_DATA[base + 2];
      a.x = INITIAL_ACTORS_DATA[base + 3];
      a.y = INITIAL_ACTORS_DATA[base + 4];
      a.colour = INITIAL_ACTORS_DATA[base + 5];
      a.vx = INITIAL_ACTORS_DATA[base + 6];
      a.vy = INITIAL_ACTORS_DATA[base + 7];
      a.extra8 = INITIAL_ACTORS_DATA[base + 8];
      a.amuletFlags = INITIAL_ACTORS_DATA[base + 11];
    }

    // Place 4 Amulet pieces in 1 of 8 room sets ($A255)
    const setIdx = this.advanceRandom() & 0x07;
    for (let b = 4; b >= 1; b--) {
      const slotOffset = 4 - b;
      const amuletActor = world.actors[SLOT_AMULET_FIRST + slotOffset];
      const room = AMULET_ROOM_SETS[setIdx * 4 + slotOffset];
      const layoutIdx = JUNGLE_LAYOUT[room];
      amuletActor.spriteId = 0x8f + b; // $93, $92, $91, $90
      amuletActor.room = room;
      amuletActor.x = OBJECT_LOCATIONS[layoutIdx * 8];
      amuletActor.y = OBJECT_LOCATIONS[layoutIdx * 8 + 1];
      amuletActor.colour = 0x46;
    }

    // Generate 512-byte room pickup table ($A2BD)
    let romAddr = ((this.gameTimer & 0x1f) << 8) | (this.framesCounter & 0xff);
    let bc = 0x0200;
    for (let idx = 0; idx < 512; idx++) {
      const romByte = ROM_NOISE[romAddr & 0x1fff];
      romAddr++;
      if (romByte >= 0x80) {
        world.roomObjects[idx] = 0x00;
      } else {
        const posBits = ((bc & 0x03) << 6) & 0xc0;
        const objType = this.randomSeed & 0x0f;
        world.roomObjects[idx] = posBits | objType;
        this.randomSeed = (this.randomSeed + this.rReg + idx) & 0xff;
      }
      bc--;
    }
  }

  private beginPlayerTurn(playStartUpTune: boolean): void {
    const world = this.players[this.activePlayerIdx];
    const player = world.actors[SLOT_PLAYER];

    world.lives = Math.max(0, world.lives - 1);
    this.drawLives();

    this.gameDelayTimer = 0x80;
    this.orchidEffectTimer = 0;
    this.nastieSpawnDelay = 0x10;
    this.flameSpawnDelay = 0x80;
    this.savedActorIndex = 1;
    this.actorCycleBudgetT = 0;

    markRoomVisited(world, player.room);
    this.drawCurrentRoom(null, false);

    if (playStartUpTune) {
      this.phase = "STARTUP_TUNE";
      const dur = this.beeper.playTune(TUNE_STARTUP);
      this.phaseWaitFrames = Math.ceil(dur * 50) + 4;
    } else {
      this.phase = "PLAYING";
    }
  }

  private drawCurrentRoom(
    previousRoom: number | null,
    includePlayer: boolean,
  ): void {
    const world = this.players[this.activePlayerIdx];
    const player = world.actors[SLOT_PLAYER];

    if (previousRoom !== null) {
      saveOrchidState(world, previousRoom);
    }
    loadOrchidForRoom(world, player.room);
    setUpRoomObjects(world, player.room);

    this.screen.clearPlayArea();
    const layoutIdx = JUNGLE_LAYOUT[player.room];
    this.drawStampList(ROOM_TEMPLATES[layoutIdx]);
    drawActorsInRoom(this.screen, world, player.room, includePlayer);
  }

  // ==========================================================================
  // 50 HZ MAIN GAMEPLAY LOOP ($99AA)
  // ==========================================================================

  private estimateActorSlotCyclesT(
    actor: { spriteId: number; room: number },
    playerRoom: number,
  ): number {
    const id = actor.spriteId;
    if (id === 0) return 900;

    if (actor.room !== playerRoom) {
      // Off-screen wandering creatures still run MoveActor + SlideActorPastObjects against ~20 room stamps
      if (
        (id >= 0x30 && id <= 0x33) ||
        (id >= 0x38 && id <= 0x3f) ||
        (id >= 0x50 && id <= 0x5d) ||
        (id >= 0xa0 && id <= 0xaf)
      ) {
        return 6_500;
      }
      return 1_400;
    }

    // On-screen static/simple items (Orchid, Pickups, Extra Life, Amulet Pieces)
    if ((id >= 0x48 && id <= 0x4f) || (id >= 0x80 && id <= 0x93)) {
      return 5_000;
    }

    // On-screen Flame & materializing Nasties include blocking Z80 beeper loops
    if ((id >= 0x01 && id <= 0x05) || (id >= 0x34 && id <= 0x37)) {
      return 38_000;
    }

    // On-screen moving creatures/hazards (XOR erase + stamp collision + AI + XOR draw + attributes)
    return 22_000;
  }

  private stepGameplayFrame(): void {
    const world = this.players[this.activePlayerIdx];
    const player = world.actors[SLOT_PLAYER];

    // 1. Always step Sabreman (slot 0) once per 50 Hz frame ($99AF)
    stepActorSlot(world, SLOT_PLAYER, this.callbacks);
    if (this.phase !== "PLAYING") return;

    // 2. Step remaining actor slots (1..24) using realistic 3.5 MHz Z80 T-state budget
    // (~28,000T left of 69,888T after Sabreman's XOR draw, stamp collision, footstep & ULA contention),
    // carrying cycle deficits across frames so full passes run at an authentic ~9-16 Hz instead of ~46 Hz.
    const FRAME_ACTOR_BUDGET_T = 28_000;
    this.actorCycleBudgetT = Math.min(
      FRAME_ACTOR_BUDGET_T,
      this.actorCycleBudgetT + FRAME_ACTOR_BUDGET_T,
    );

    while (this.actorCycleBudgetT > 0 && this.phase === "PLAYING") {
      const slot = this.savedActorIndex;
      const actor = world.actors[slot];
      const costT = this.estimateActorSlotCyclesT(actor, player.room);

      stepActorSlot(world, slot, this.callbacks);
      this.actorCycleBudgetT -= costT;

      this.savedActorIndex++;
      if (this.savedActorIndex >= NUM_ACTORS) {
        this.savedActorIndex = 1;
        // Full pass completed -> UpdateCounters ($9A17)
        this.gameTimer = (this.gameTimer + 1) & 0xffff;
        trySpawnNastie(world, this.callbacks);
        trySpawnFlame(world, this.callbacks);
        this.actorCycleBudgetT -= 3_200;
      }
    }
  }

  // ==========================================================================
  // CUTSCENES: SHOW AMULET + POEM ($A207), GAME COMPLETE ($9F6A), DEATH & GAME OVER ($AA27)
  // ==========================================================================

  private enterShowAmuletPhase(): void {
    this.phase = "SHOW_AMULET";
    const world = this.players[this.activePlayerIdx];
    const player = world.actors[SLOT_PLAYER];
    for (const a of world.actors) a.drawnOnScreen = false;

    this.screen.clearPlayArea();

    // Draw the 4 amulet quadrants ($A207-$A233):
    // AMULET_DISPLAY_STAMPS order in ROM is piece 4 (bit 3), piece 3 (bit 2), piece 2 (bit 1), piece 1 (bit 0)
    const flags = player.amuletFlags & 0x0f;
    for (let i = 0; i < 4; i++) {
      const bitMask = 0x08 >>> i;
      const collected = (flags & bitMask) !== 0;
      const st = AMULET_DISPLAY_STAMPS[i];
      this.screen.drawStamp(BACKGROUNDS[st.bg], st.x, st.y, collected);
    }

    const count = Math.max(1, Math.min(4, countAmuletPieces(flags)));
    for (const msg of POEMS[count - 1]) {
      this.screen.printColourString(msg.x, msg.y, msg.attr, msg.text);
    }

    const dur = this.beeper.playTune(TUNE_POEM);
    this.phaseWaitFrames = Math.ceil(dur * 50) + 125; // + ~2.5s pause ($A23D)
  }

  private enterGameCompletePhase(): void {
    this.phase = "GAME_COMPLETE";
    const world = this.players[this.activePlayerIdx];
    for (const a of world.actors) a.drawnOnScreen = false;

    this.screen.clearPlayArea();
    this.drawStampList(ROOM_COMPLETE);
    for (const msg of GAME_COMPLETE_MESSAGES) {
      this.screen.printColourString(msg.x, msg.y, msg.attr, msg.text);
    }

    const dur = this.beeper.playTune(TUNE_MAIN);
    this.phaseWaitFrames = Math.ceil(dur * 50) + 60;
  }

  private handlePlayerTurnEnded(): void {
    const curWorld = this.players[this.activePlayerIdx];
    const curPlayer = curWorld.actors[SLOT_PLAYER];
    const otherIdx: 0 | 1 = this.activePlayerIdx === 0 ? 1 : 0;
    const otherWorld = this.players[otherIdx];

    if (this.twoPlayers && otherWorld.lives > 0) {
      if (curWorld.lives === 0) {
        // Show Game Over for current player first, then switch to other player ($AA60-$AA67)
        this.showGameOverScreenFor((this.activePlayerIdx + 1) as 1 | 2);
        return;
      }
      this.switchToOtherPlayer();
      return;
    }

    // 1-player mode (or other player has 0 lives left) ($AA2E)
    if (curWorld.lives > 0) {
      curWorld.lives--;
      this.drawLives();
      curPlayer.spriteId = 0x10 | (curWorld.facingRight ? 0x04 : 0x00);
      curPlayer.colour = 0x47;
      curPlayer.state = 0;
      this.orchidEffectTimer = 0;
      this.nastieSpawnDelay = 0x10;
      this.flameSpawnDelay = 0x80;
      if (this.phase !== "PLAYING") {
        this.phase = "PLAYING";
        this.drawCurrentRoom(null, true);
      }
      return;
    }

    // All lives exhausted! Show Game Over ($AAA4)
    this.showGameOverScreenFor((this.activePlayerIdx + 1) as 1 | 2);
  }

  private switchToOtherPlayer(): void {
    // Unflash current player's HUD label
    for (let c = 0; c < 32; c++) this.screen.attrs[c] &= 0x7f;
    this.activePlayerIdx = this.activePlayerIdx === 0 ? 1 : 0;
    const nextWorld = this.players[this.activePlayerIdx];
    const nextPlayer = nextWorld.actors[SLOT_PLAYER];
    nextPlayer.spriteId = 0x10 | (nextWorld.facingRight ? 0x04 : 0x00);
    nextPlayer.colour = 0x47;
    nextPlayer.state = 0;
    this.beginPlayerTurn(false);
  }

  private showGameOverScreenFor(playerNum: 1 | 2): void {
    this.phase = "GAME_OVER";
    const world = this.players[playerNum - 1];
    const player = world.actors[SLOT_PLAYER];
    for (const a of world.actors) a.drawnOnScreen = false;

    this.screen.clearPlayArea();
    for (const msg of getGameOverMessages(playerNum)) {
      this.screen.printColourString(msg.x, msg.y, msg.attr, msg.text);
    }

    // Print percentage at screen address $48F8 => col 24, Y = $78 ($9CC6-$9D20)
    const pct = computeAdventurePercentage(
      world.visitedRooms,
      player.amuletFlags,
    );
    if (pct >= 100) {
      this.screen.printCharAtCol(0x31, 24, 0x78); // '1'
      this.screen.printCharAtCol(0x30, 25, 0x78); // '0'
      this.screen.printCharAtCol(0x30, 26, 0x78); // '0'
    } else {
      const tens = Math.floor(pct / 10);
      const units = pct % 10;
      this.screen.printCharAtCol(0x30 + tens, 25, 0x78);
      this.screen.printCharAtCol(0x30 + units, 26, 0x78);
    }

    const dur = this.beeper.playTune(TUNE_GAME_OVER);
    this.phaseWaitFrames = Math.ceil(dur * 50) + 90;
  }

  private afterGameOverScreen(): void {
    const otherIdx: 0 | 1 = this.activePlayerIdx === 0 ? 1 : 0;
    if (this.twoPlayers && this.players[otherIdx].lives > 0) {
      this.switchToOtherPlayer();
      return;
    }

    // Both players done -> check Hall of Fame ($B5FC: highest scorer first!)
    this.hallOfFameUpdated = false;
    const cmp = compareBcdScores(
      this.players[0].scoreBcd,
      this.players[1].scoreBcd,
    );
    if (this.twoPlayers) {
      this.pendingHighScoreQueue = cmp >= 0 ? [0, 1] : [1, 0];
    } else {
      this.pendingHighScoreQueue = [0];
    }
    this.processNextHighScoreCandidate();
  }

  // ==========================================================================
  // HIGH SCORE REGISTRATION ($B61E-$B742)
  // ==========================================================================

  private processNextHighScoreCandidate(): void {
    while (this.pendingHighScoreQueue.length > 0) {
      const pIdx = this.pendingHighScoreQueue.shift()!;
      const score = this.players[pIdx].scoreBcd;

      // Find lowest slot beaten (Top 5 on mobile where 6th row is 'BACK TO MENU', Top 6 on desktop)
      const maxSlots = this.isMobileMenuLayout() ? 5 : 6;
      let insertAt = -1;
      for (let i = 0; i < maxSlots; i++) {
        if (compareBcdScores(score, this.highScores[i].score) > 0) {
          insertAt = i;
          break;
        }
      }

      if (insertAt !== -1) {
        const placesBeaten = 6 - insertAt;
        // Shift entries down
        for (let i = 5; i > insertAt; i--) {
          this.highScores[i] = {
            score: [...this.highScores[i - 1].score] as [
              number,
              number,
              number,
            ],
            initials: this.highScores[i - 1].initials,
          };
        }
        this.highScores[insertAt] = {
          score: [...score] as [number, number, number],
          initials: "   ",
        };
        this.drawScores();

        if (!this.hallOfFameUpdated) {
          this.hallOfFameUpdated = true;
          this.screen.clearPlayArea();
          this.drawStampList(ROOM_MAIN_MENU);
        }
        this.screen.clearPanel();
        const msgs = getNewHighScoreMessages((pIdx + 1) as 1 | 2, placesBeaten);
        for (const msg of msgs) {
          this.screen.printColourString(msg.x, msg.y, msg.attr, msg.text);
        }

        this.activePlayerIdx = pIdx;
        this.currentInitialSlotIdx = insertAt;
        this.currentInitialCharIndex = 0;
        this.currentInitialAscii = 0x41; // Start conveniently at 'A' (wrapping ' ' <-> 'A'..'Z')
        this.initialInputCooldown = 8;
        this.waitingFireRelease = true;
        this.phase = "ENTER_INITIALS";
        this.renderInitialsEntryRow();
        return;
      }
    }

    // Done with all candidates!
    if (this.hallOfFameUpdated) {
      this.saveHighScores();
      this.enterHallOfFame(false);
    } else {
      this.enterMenu();
    }
  }

  public stepInitialLetter(delta: -1 | 1): void {
    if (this.phase !== "ENTER_INITIALS") return;
    this.beeper.playHighTone();
    if (delta < 0) {
      this.currentInitialAscii--;
      if (this.currentInitialAscii === 0x40) this.currentInitialAscii = 0x20;
      else if (this.currentInitialAscii < 0x20) this.currentInitialAscii = 0x5a;
    } else {
      this.currentInitialAscii++;
      if (this.currentInitialAscii === 0x5b) this.currentInitialAscii = 0x20;
      else if (this.currentInitialAscii === 0x21)
        this.currentInitialAscii = 0x41;
    }
    this.renderInitialsEntryRow();
  }

  public confirmInitialLetter(): void {
    if (this.phase !== "ENTER_INITIALS") return;
    this.acceptCurrentInitialChar();
  }

  public canBackspaceInitial(): boolean {
    return this.phase === "ENTER_INITIALS" && this.currentInitialCharIndex > 0;
  }

  public backspaceInitialLetter(): void {
    if (!this.canBackspaceInitial()) return;
    this.currentInitialCharIndex--;
    const chars =
      this.highScores[this.currentInitialSlotIdx].initials.split("");
    const prevCode = chars[this.currentInitialCharIndex]?.charCodeAt(0) ?? 0x41;
    this.currentInitialAscii =
      prevCode === 0x20 || (prevCode >= 0x41 && prevCode <= 0x5a)
        ? prevCode
        : 0x41;
    chars[this.currentInitialCharIndex] = " ";
    this.highScores[this.currentInitialSlotIdx].initials = chars.join("");
    this.beeper.playHighTone();
    this.renderInitialsEntryRow();
  }

  private renderInitialsEntryRow(): void {
    const yPx = 0x98;
    // Frame the 3 initial slots with crisp Bright Cyan '<' and '>' indicators
    this.screen.printColourString(11 * 8, yPx, 0x45, "<");
    this.screen.printColourString(19 * 8, yPx, 0x45, ">");

    const saved = this.highScores[this.currentInitialSlotIdx]?.initials ?? "   ";
    for (let i = 0; i < 3; i++) {
      const col = 13 + i * 2;
      if (i < this.currentInitialCharIndex) {
        const ch = saved[i] || " ";
        this.screen.printColourString(col * 8, yPx, 0x47, ch);
      } else if (i === this.currentInitialCharIndex) {
        // Authentic ZX Spectrum FLASH + BRIGHT Yellow cursor on the active letter slot
        this.screen.printColourString(
          col * 8,
          yPx,
          0xc6,
          String.fromCharCode(this.currentInitialAscii),
        );
      } else {
        this.screen.printColourString(col * 8, yPx, 0x45, "-");
      }
    }
  }

  private stepEnterInitialsFrame(): void {
    if (this.initialInputCooldown > 0) {
      this.initialInputCooldown--;
    }

    if (this.input.consumeJustPressed("Backspace")) {
      this.backspaceInitialLetter();
      return;
    }

    // Direct keyboard A-Z typing convenience alongside Left/Right/Fire!
    for (let code = 65; code <= 90; code++) {
      const keyCode = `Key${String.fromCharCode(code)}`;
      if (this.input.consumeJustPressed(keyCode)) {
        this.currentInitialAscii = code;
        this.acceptCurrentInitialChar();
        return;
      }
    }

    const controls = this.input.readControls(this.controlMethod);
    if (this.waitingFireRelease) {
      if ((controls & CTRL_FIRE) === 0) {
        this.waitingFireRelease = false;
      }
      return;
    }

    if ((controls & CTRL_FIRE) !== 0) {
      this.waitingFireRelease = true;
      this.acceptCurrentInitialChar();
      return;
    }

    if (this.initialInputCooldown === 0) {
      if ((controls & CTRL_LEFT) !== 0) {
        this.stepInitialLetter(-1);
        this.initialInputCooldown = 7;
      } else if ((controls & CTRL_RIGHT) !== 0) {
        this.stepInitialLetter(1);
        this.initialInputCooldown = 7;
      }
    }
  }

  private acceptCurrentInitialChar(): void {
    const chars =
      this.highScores[this.currentInitialSlotIdx].initials.split("");
    chars[this.currentInitialCharIndex] = String.fromCharCode(
      this.currentInitialAscii,
    );
    this.highScores[this.currentInitialSlotIdx].initials = chars.join("");
    this.beeper.playLowTone();

    this.currentInitialCharIndex++;
    if (this.currentInitialCharIndex >= 3) {
      this.renderInitialsEntryRow();
      this.saveHighScores();
      this.processNextHighScoreCandidate();
    } else {
      this.currentInitialAscii = 0x41;
      this.renderInitialsEntryRow();
      this.initialInputCooldown = 10;
    }
  }

  // ==========================================================================
  // HELPERS & PERSISTENCE
  // ==========================================================================

  private advanceRandom(): number {
    // Emulates Z80 R-register + seed mixing ($9695)
    this.randomSeed =
      ((this.randomSeed * 5 + 1) ^ this.rReg ^ (this.framesCounter & 0xff)) &
      0xff;
    return this.randomSeed;
  }

  private loadHighScores(): HighScoreEntry[] {
    try {
      const raw = localStorage.getItem(HOF_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as HighScoreEntry[];
        if (Array.isArray(parsed) && parsed.length === 6) {
          return parsed.map((e) => ({
            score: [e.score[0] & 0xff, e.score[1] & 0xff, e.score[2] & 0xff],
            initials: (e.initials || "   ").padEnd(3, " ").slice(0, 3),
          }));
        }
      }
    } catch {
      // Fallback to default
    }
    return DEFAULT_HIGH_SCORES.map((e) => ({
      score: [...e.score] as [number, number, number],
      initials: e.initials,
    }));
  }

  private saveHighScores(): void {
    try {
      localStorage.setItem(HOF_STORAGE_KEY, JSON.stringify(this.highScores));
    } catch {
      // Ignore storage quota errors
    }
  }
}
