import { FLAME_SOUND_TABLE, MUSIC_NOTES } from '../data/audioData';
import { ROM_NOISE } from '../data/zxFont';

const Z80_CLOCK_HZ = 3_500_000;

interface ToneSegment {
  readonly halfPeriodT: number; // 0 means silence of `durationT`
  readonly cycles: number;
  readonly durationT?: number;
}

/**
 * Hardware-accurate 3.5 MHz Z80 1-bit ZX Spectrum beeper synthesizer.
 * Translates exact Sabre Wulf Z80 OUT ($FE),A loops into sample-accurate square-wave buffers.
 */
export class ZXBeeper {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private filterNode: BiquadFilterNode | null = null;

  private muted = false;
  private paused = false;
  private volume = 0.35;

  private activeTuneSource: AudioBufferSourceNode | null = null;
  private tuneEndTime = 0;

  // Footstep counter ($96B3)
  public footstepCounter = 0;

  public unlock(): void {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      this.ctx = new AudioCtx();

      // Gentle speaker cone shaping so 1-bit square waves sound like a real 48K ZX Spectrum speaker
      this.filterNode = this.ctx.createBiquadFilter();
      this.filterNode.type = 'lowpass';
      this.filterNode.frequency.value = 4800;
      this.filterNode.Q.value = 0.6;

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : this.volume;

      this.filterNode.connect(this.masterGain);
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.paused) {
      if (this.ctx.state === 'running') {
        void this.ctx.suspend();
      }
      return;
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  public setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (!this.ctx) return;
    if (paused && this.ctx.state === 'running') {
      void this.ctx.suspend();
    } else if (!paused && this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  public isPaused(): boolean {
    return this.paused;
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.masterGain && this.ctx) {
      const gain = muted ? 0 : this.volume;
      this.masterGain.gain.value = gain;
      this.masterGain.gain.setValueAtTime(gain, this.ctx.currentTime);
    }
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(1, vol));
    if (this.masterGain && this.ctx && !this.muted) {
      this.masterGain.gain.setValueAtTime(this.volume, this.ctx.currentTime);
    }
  }

  public getVolume(): number {
    return this.volume;
  }

  public stopTune(): void {
    if (this.activeTuneSource) {
      try {
        this.activeTuneSource.stop();
        this.activeTuneSource.disconnect();
      } catch {
        // Ignore already-stopped source
      }
      this.activeTuneSource = null;
    }
    this.tuneEndTime = 0;
  }

  public isPlayingTune(): boolean {
    if (!this.ctx || !this.activeTuneSource) return false;
    return this.ctx.currentTime < this.tuneEndTime;
  }

  /** Play one of the 4 Sabre Wulf music tables ($BD51 / $BD6E). Returns duration in seconds. */
  public playTune(tuneBytes: Uint8Array, onEnded?: () => void): number {
    this.stopTune();
    const segments: ToneSegment[] = [];

    for (let i = 0; i < tuneBytes.length; i++) {
      const b = tuneBytes[i];
      if (b === 0xff) break;
      const note = b & 0x3f;
      const len = ((b >> 6) & 0x03) + 1;

      if (note === 0) {
        // Rest ($BDBC): L = len, BC = $430B * 26 T-states = 446,238 T-states per unit
        segments.push({ halfPeriodT: 0, cycles: 0, durationT: len * 446_238 });
      } else {
        const off = note * 4;
        const delayB = MUSIC_NOTES[off];
        const delayC = MUSIC_NOTES[off + 1];
        const baseCycles = MUSIC_NOTES[off + 2] | (MUSIC_NOTES[off + 3] << 8);
        const bCount = delayB === 0 ? 256 : delayB;
        const halfPeriodT = bCount * 13 + Math.max(0, delayC - 1) * 3339 + 30;
        segments.push({ halfPeriodT, cycles: baseCycles * len });
      }
    }

    const totalT = this.computeTotalT(segments);
    const durationSec = totalT / Z80_CLOCK_HZ;

    if (!this.ctx || !this.filterNode) {
      return durationSec;
    }
    if (!this.paused && this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }

    const buffer = this.renderSegments(segments);
    if (!buffer) return durationSec;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.filterNode);
    this.activeTuneSource = src;
    this.tuneEndTime = this.ctx.currentTime + buffer.duration;
    src.onended = () => {
      if (this.activeTuneSource === src) {
        this.activeTuneSource = null;
      }
      onEnded?.();
    };
    src.start();
    return buffer.duration;
  }

  /** Low-level $BF6D/$BF74 wave helper */
  public playSquareWave(halfPeriodB: number, cyclesC: number): void {
    const bCount = (halfPeriodB & 0xff) === 0 ? 256 : halfPeriodB & 0xff;
    const cCount = (cyclesC & 0xff) === 0 ? 256 : cyclesC & 0xff;
    this.playSegments([{ halfPeriodT: bCount * 13 + 27, cycles: cCount }]);
  }

  /** $BEC6 PlayOrchidFlashBeep */
  public playOrchidFlashBeep(): void {
    this.playSquareWave(0xa0, 0x08);
  }

  /** $BF25 PlayHighTone (pickup collected / high score initial step) */
  public playHighTone(): void {
    this.playSquareWave(0x40, 0x30);
  }

  /** $BF2A PlayLowTone (start-of-turn flash / orchid touched / initial accepted) */
  public playLowTone(): void {
    this.playSquareWave(0x80, 0x10);
  }

  /** $BF08 PlayAppearingSound (nastie materializing $01..$05) */
  public playAppearingSound(spriteId: number): void {
    const inv = (~spriteId) & 0xff;
    // RRCA x 3, AND %11100000
    const rrca3 = ((inv >>> 3) | (inv << 5)) & 0xe0;
    this.playSquareWave(rrca3, 0x06);
  }

  /** $BF17 PlayWarbleSound (rhino/tribesman sword hit, waking hippo, cave guardian push) */
  public playWarbleSound(): void {
    const segments: ToneSegment[] = [];
    for (let c = 0x30; c > 0; c--) {
      const a = this.daaAdd(c | 0x18);
      const bCount = a === 0 ? 256 : a;
      segments.push({ halfPeriodT: bCount * 13 + 27, cycles: 1 });
    }
    this.playSegments(segments);
  }

  /** $BF2F PlayNoiseSound (Sabreman thud landing after being knocked back) */
  public playNoiseSound(): void {
    const segments: ToneSegment[] = [];
    for (let c = 0x30; c > 0; c--) {
      const b = ((c ^ 0x55) + c) & 0xff;
      const bCount = b === 0 ? 256 : b;
      segments.push({ halfPeriodT: bCount * 13 + 27, cycles: 1 });
    }
    this.playSegments(segments);
  }

  /** $BEEE PlayExplosionSound (nastie or flame blowing up) */
  public playExplosionSound(randomSeed: number, gameTimerLow: number): void {
    let addr = ((gameTimerLow & 0x1f) << 8) | (randomSeed & 0xff);
    const segments: ToneSegment[] = [];
    for (let e = 0x10; e > 0; e--) {
      const b = ROM_NOISE[addr & 0x1fff] & 0x7f;
      addr++;
      const bCount = b === 0 ? 256 : b;
      segments.push({ halfPeriodT: bCount * 13 + 27, cycles: 2 });
    }
    this.playSegments(segments);
  }

  /** $BECC PlayFlameSound (bushfire crackling) */
  public playFlameSound(gameTimerLow: number): void {
    const b = FLAME_SOUND_TABLE[gameTimerLow & 0x0f];
    this.playSquareWave(b, 0x10);
  }

  /** $BF3D PlayAmuletPieceSound (tribesman aligned with amulet piece) */
  public playAmuletPieceSound(dist: number, actorX: number, actorY: number): void {
    let a = (dist + actorX + actorY) & 0xff;
    // RLCA x 2
    a = ((a << 2) | (a >>> 6)) & 0xff;
    this.playSquareWave(a, 0x08);
  }

  /** $BF4B PlayFootstepSound (alternating $60/$40 tick every 8 steps; double speed when Cyan!) */
  public playFootstepSound(playerColour: number): void {
    this.stepFootstepOnce();
    if (playerColour === 0x45) {
      this.stepFootstepOnce();
    }
  }

  private stepFootstepOnce(): void {
    this.footstepCounter = (this.footstepCounter + 1) & 0xff;
    if ((this.footstepCounter & 0x07) !== 0) return;
    const halfPeriod = (this.footstepCounter & 0x08) !== 0 ? 0x40 : 0x60;
    this.playSquareWave(halfPeriod, 0x04);
  }

  /** Z80 DAA approximation used by $BF1C (`OR %00011000; DAA`) */
  private daaAdd(val: number): number {
    let a = val & 0xff;
    if ((a & 0x0f) > 9) a = (a + 0x06) & 0xff;
    if ((a & 0xf0) > 0x90) a = (a + 0x60) & 0xff;
    return a;
  }

  private playSegments(segments: ToneSegment[]): void {
    if (!this.ctx || !this.filterNode || this.muted) return;
    if (!this.paused && this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    const buffer = this.renderSegments(segments);
    if (!buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.filterNode);
    src.start();
  }

  private computeTotalT(segments: readonly ToneSegment[]): number {
    let totalT = 0;
    for (const seg of segments) {
      if (seg.halfPeriodT === 0) {
        totalT += seg.durationT ?? 0;
      } else {
        totalT += seg.halfPeriodT * 2 * seg.cycles;
      }
    }
    return totalT;
  }

  private renderSegments(segments: readonly ToneSegment[]): AudioBuffer | null {
    if (!this.ctx || segments.length === 0) return null;
    const sampleRate = this.ctx.sampleRate;
    const tStatesPerSample = Z80_CLOCK_HZ / sampleRate;
    const totalT = this.computeTotalT(segments);
    const totalSamples = Math.max(1, Math.ceil(totalT / tStatesPerSample) + 16);

    const buffer = this.ctx.createBuffer(1, totalSamples, sampleRate);
    const out = buffer.getChannelData(0);

    let segIdx = 0;
    let segRemT =
      segments[0].halfPeriodT === 0
        ? segments[0].durationT ?? 0
        : segments[0].halfPeriodT * 2 * segments[0].cycles;
    let phaseT = 0;

    for (let i = 0; i < totalSamples; i++) {
      while (segIdx < segments.length && segRemT <= 0) {
        segIdx++;
        if (segIdx < segments.length) {
          const s = segments[segIdx];
          segRemT += s.halfPeriodT === 0 ? s.durationT ?? 0 : s.halfPeriodT * 2 * s.cycles;
          phaseT = 0;
        }
      }

      if (segIdx >= segments.length) {
        out[i] = 0;
        continue;
      }

      const cur = segments[segIdx];
      if (cur.halfPeriodT === 0) {
        out[i] = 0;
      } else {
        const periodT = cur.halfPeriodT * 2;
        const p = phaseT % periodT;
        out[i] = p < cur.halfPeriodT ? 0.55 : -0.55;
        phaseT += tStatesPerSample;
      }
      segRemT -= tStatesPerSample;
    }

    // Tiny 12-sample de-click tail
    const tail = Math.min(12, totalSamples);
    for (let j = 0; j < tail; j++) {
      out[totalSamples - 1 - j] *= j / tail;
    }

    return buffer;
  }
}
