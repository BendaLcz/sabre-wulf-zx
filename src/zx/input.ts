// Authentic Sabre Wulf Input System ($B0A3 & $AC28 & Menu Keys) + Modern Conveniences

// Control bitmask matching Z80 register C in ReadControls ($B0A3):
// Bit 0: Left, Bit 1: Right, Bit 2: Up, Bit 3: Down, Bit 4: Fire (Sword)
export const CTRL_LEFT = 0x01;
export const CTRL_RIGHT = 0x02;
export const CTRL_UP = 0x04;
export const CTRL_DOWN = 0x08;
export const CTRL_FIRE = 0x10;

export enum ControlMethod {
  KEYBOARD = 0,     // Q=Left, W=Right, E=Up, R=Down (or E=Down, R=Up — verified below!), T/SymShift=Fire + Arrows/WASD/Space
  KEMPSTON = 1,     // Browser Gamepad API (+ Arrows/Space fallback)
  CURSOR = 2,       // 5=Left, 8=Right, 7=Up, 6=Down, 0=Fire
  INTERFACE_II = 3, // 6=Left, 7=Right, 9=Up, 8=Down, 0=Fire
}

export class ZXInput {
  private readonly pressedCodes = new Set<string>();
  private readonly pressedKeys = new Set<string>();
  private readonly justPressedCodes = new Set<string>();

  // Virtual touch controls bitmask
  public touchControlsMask = 0;

  // Track if Shift was used alone for authentic CapsShift pause vs Shift+key
  private pauseLatchRequested = false;

  constructor() {
    window.addEventListener('keydown', (e) => {
      // Prevent browser scrolling on game keys
      if (
        e.code === 'ArrowUp' ||
        e.code === 'ArrowDown' ||
        e.code === 'ArrowLeft' ||
        e.code === 'ArrowRight' ||
        e.code === 'Space'
      ) {
        e.preventDefault();
      }
      if (!this.pressedCodes.has(e.code)) {
        this.justPressedCodes.add(e.code);
        if (e.code === 'KeyP' || e.code === 'Pause') {
          this.pauseLatchRequested = !this.pauseLatchRequested;
        }
      }
      this.pressedCodes.add(e.code);
      this.pressedKeys.add(e.key.toUpperCase());
    });

    window.addEventListener('keyup', (e) => {
      this.pressedCodes.delete(e.code);
      this.pressedKeys.delete(e.key.toUpperCase());
    });

    window.addEventListener('blur', () => {
      this.pressedCodes.clear();
      this.pressedKeys.clear();
      this.touchControlsMask = 0;
    });
  }

  public clearJustPressed(): void {
    this.justPressedCodes.clear();
  }

  public consumeJustPressed(code: string): boolean {
    if (this.justPressedCodes.has(code)) {
      this.justPressedCodes.delete(code);
      return true;
    }
    return false;
  }

  public isAnyKeyDown(): boolean {
    if (this.pressedCodes.size > 0 || this.touchControlsMask !== 0) return true;
    return this.readGamepadMask() !== 0;
  }

  public isPaused(): boolean {
    return this.pauseLatchRequested;
  }

  public setPaused(paused: boolean): void {
    this.pauseLatchRequested = paused;
  }

  public checkAnyKeyUnpause(): boolean {
    if (!this.pauseLatchRequested) return false;
    // Any non-P key unpauses just like Ultimate's $AC28 loop!
    for (const code of this.justPressedCodes) {
      if (code !== 'KeyP' && code !== 'Pause') {
        this.pauseLatchRequested = false;
        this.justPressedCodes.delete(code);
        return true;
      }
    }
    if (this.touchControlsMask !== 0) {
      this.pauseLatchRequested = false;
      return true;
    }
    return false;
  }

  /**
   * Read 5-bit control mask matching Sabre Wulf's $B0A3 ReadControls:
   * - Original ZX Spectrum Keyboard ($B0AD):
   *   Row Q-T ($FBFE): Q=Left, W=Right, E=Down, R=Up, T=Fire
   *   Row A-G ($FDFE): A..G=Down, Row Z-V ($FEFE): Z..V=Up (classic Ultimate multi-row layout!)
   *   Row H-Enter ($BFFE) / B-Space ($7FFE): Enter/Space/M/N/B = Fire!
   * - Plus universal Arrow Keys + WASD + Space/Z/X/Enter convenience so any player can play immediately!
   */
  public readControls(method: ControlMethod): number {
    let mask = this.touchControlsMask;

    // Modern convenience keys always work seamlessly alongside any selected mode
    if (this.pressedCodes.has('ArrowLeft')) mask |= CTRL_LEFT;
    if (this.pressedCodes.has('ArrowRight')) mask |= CTRL_RIGHT;
    if (this.pressedCodes.has('ArrowUp')) mask |= CTRL_UP;
    if (this.pressedCodes.has('ArrowDown')) mask |= CTRL_DOWN;
    if (
      this.pressedCodes.has('Space') ||
      this.pressedCodes.has('Enter') ||
      this.pressedCodes.has('ControlLeft') ||
      this.pressedCodes.has('ControlRight')
    ) {
      mask |= CTRL_FIRE;
    }

    switch (method) {
      case ControlMethod.KEYBOARD: {
        // Original Sabre Wulf Q/W/E/R/T:
        // Q = Left, W = Right, R = Up, E = Down, T = Fire (plus SymShift/Space/M/N)
        if (this.pressedCodes.has('KeyQ')) mask |= CTRL_LEFT;
        if (this.pressedCodes.has('KeyW')) mask |= CTRL_RIGHT;
        if (this.pressedCodes.has('KeyR')) mask |= CTRL_UP;
        if (this.pressedCodes.has('KeyE')) mask |= CTRL_DOWN;
        if (this.pressedCodes.has('KeyT')) mask |= CTRL_FIRE;

        // Also support standard WASD when Q/E aren't conflicting
        if (this.pressedCodes.has('KeyA')) mask |= CTRL_LEFT;
        if (this.pressedCodes.has('KeyD')) mask |= CTRL_RIGHT;
        if (this.pressedCodes.has('KeyW') && (this.pressedCodes.has('KeyA') || this.pressedCodes.has('KeyD') || this.pressedCodes.has('KeyS'))) {
          // Note: W alone is original Right, so only map S=Down, Z/X=Fire cleanly; Arrow keys give unambiguous 8-way!
        }
        if (this.pressedCodes.has('KeyS')) mask |= CTRL_DOWN;
        if (this.pressedCodes.has('KeyZ') || this.pressedCodes.has('KeyX')) mask |= CTRL_FIRE;
        break;
      }

      case ControlMethod.KEMPSTON: {
        mask |= this.readGamepadMask();
        break;
      }

      case ControlMethod.CURSOR: {
        // Sinclair Cursor / Protek Joystick: 5=Left, 6=Down, 7=Up, 8=Right, 0=Fire
        if (this.pressedCodes.has('Digit5')) mask |= CTRL_LEFT;
        if (this.pressedCodes.has('Digit6')) mask |= CTRL_DOWN;
        if (this.pressedCodes.has('Digit7')) mask |= CTRL_UP;
        if (this.pressedCodes.has('Digit8')) mask |= CTRL_RIGHT;
        if (this.pressedCodes.has('Digit0')) mask |= CTRL_FIRE;
        break;
      }

      case ControlMethod.INTERFACE_II: {
        // ZX Interface II Port 1: 6=Left, 7=Right, 8=Down, 9=Up, 0=Fire
        if (this.pressedCodes.has('Digit6')) mask |= CTRL_LEFT;
        if (this.pressedCodes.has('Digit7')) mask |= CTRL_RIGHT;
        if (this.pressedCodes.has('Digit8')) mask |= CTRL_DOWN;
        if (this.pressedCodes.has('Digit9')) mask |= CTRL_UP;
        if (this.pressedCodes.has('Digit0')) mask |= CTRL_FIRE;
        break;
      }
    }

    // Also allow connected Gamepad in any mode!
    mask |= this.readGamepadMask();

    return mask;
  }

  private readGamepadMask(): number {
    if (typeof navigator.getGamepads !== 'function') return 0;
    const pads = navigator.getGamepads();
    let mask = 0;
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const axX = pad.axes[0] ?? 0;
      const axY = pad.axes[1] ?? 0;
      if (axX < -0.4 || pad.buttons[14]?.pressed) mask |= CTRL_LEFT;
      if (axX > 0.4 || pad.buttons[15]?.pressed) mask |= CTRL_RIGHT;
      if (axY < -0.4 || pad.buttons[12]?.pressed) mask |= CTRL_UP;
      if (axY > 0.4 || pad.buttons[13]?.pressed) mask |= CTRL_DOWN;
      if (
        pad.buttons[0]?.pressed ||
        pad.buttons[1]?.pressed ||
        pad.buttons[2]?.pressed ||
        pad.buttons[3]?.pressed
      ) {
        mask |= CTRL_FIRE;
      }
    }
    return mask;
  }

  public isDigitDown(digit: 0 | 1 | 2 | 3 | 4 | 5 | 6): boolean {
    return this.pressedCodes.has(`Digit${digit}`) || this.pressedCodes.has(`Numpad${digit}`);
  }
}
