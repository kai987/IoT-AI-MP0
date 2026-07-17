"""Procedurally generated music and sound effects for Emotion Runner.

All audio is synthesized at startup, so the project has no external music
licenses or binary asset dependencies. If an audio device cannot be opened,
the manager becomes a silent no-op and the game remains playable.
"""

from __future__ import annotations

import math

import numpy as np
import pygame

from . import settings


SAMPLE_RATE = settings.AUDIO_SAMPLE_RATE


def _envelope(length: int, attack: float, release: float) -> np.ndarray:
    result = np.ones(length, dtype=np.float32)
    attack_samples = min(length, int(SAMPLE_RATE * attack))
    release_samples = min(length - attack_samples, int(SAMPLE_RATE * release))
    if attack_samples:
        result[:attack_samples] = np.linspace(0.0, 1.0, attack_samples, endpoint=False)
    if release_samples:
        result[-release_samples:] = np.linspace(1.0, 0.0, release_samples)
    return result


def _tone(
    frequency: float,
    duration: float,
    *,
    end_frequency: float | None = None,
    wave: str = "sine",
    volume: float = 0.5,
    attack: float = 0.006,
    release: float = 0.04,
) -> np.ndarray:
    length = max(1, int(SAMPLE_RATE * duration))
    frequencies = np.linspace(
        frequency,
        end_frequency if end_frequency is not None else frequency,
        length,
        dtype=np.float32,
    )
    phase = np.cumsum(frequencies, dtype=np.float64) * (2.0 * math.pi / SAMPLE_RATE)
    sine = np.sin(phase)
    if wave == "square":
        values = np.sign(sine)
    elif wave == "triangle":
        values = (2.0 / math.pi) * np.arcsin(sine)
    elif wave == "saw":
        values = 2.0 * ((phase / (2.0 * math.pi)) % 1.0) - 1.0
    else:
        values = sine
    return (
        values.astype(np.float32)
        * _envelope(length, attack, release)
        * float(volume)
    )


def _noise(
    duration: float,
    *,
    volume: float,
    rng: np.random.Generator,
    release: float | None = None,
) -> np.ndarray:
    length = max(1, int(SAMPLE_RATE * duration))
    values = rng.uniform(-1.0, 1.0, length).astype(np.float32)
    return values * _envelope(length, 0.002, release or duration * 0.85) * volume


def _sequence(
    notes: list[tuple[float, float]],
    *,
    wave: str = "sine",
    volume: float = 0.45,
) -> np.ndarray:
    return np.concatenate(
        [
            _tone(
                frequency,
                duration,
                wave=wave,
                volume=volume,
                release=min(0.06, duration * 0.35),
            )
            for frequency, duration in notes
        ]
    )


def _mix(*signals: np.ndarray) -> np.ndarray:
    length = max(len(signal) for signal in signals)
    result = np.zeros(length, dtype=np.float32)
    for signal in signals:
        result[: len(signal)] += signal
    peak = float(np.max(np.abs(result)))
    if peak > 0.95:
        result *= 0.95 / peak
    return result


def _overlay(target: np.ndarray, signal: np.ndarray, start: float) -> None:
    start_sample = max(0, int(start * SAMPLE_RATE))
    if start_sample >= len(target):
        return
    end_sample = min(len(target), start_sample + len(signal))
    target[start_sample:end_sample] += signal[: end_sample - start_sample]


def _sound_from_mono(mono: np.ndarray) -> pygame.mixer.Sound:
    clipped = np.clip(mono, -1.0, 1.0)
    stereo = np.column_stack((clipped, clipped))
    samples = np.ascontiguousarray(stereo * 32767.0, dtype=np.int16)
    return pygame.sndarray.make_sound(samples)


def _menu_music() -> np.ndarray:
    """Eight-second relaxed arpeggio loop for the start menu."""

    duration = 8.0
    track = np.zeros(int(SAMPLE_RATE * duration), dtype=np.float32)
    chords = (
        (261.63, 329.63, 392.00),
        (220.00, 261.63, 329.63),
        (174.61, 220.00, 261.63),
        (196.00, 246.94, 293.66),
    )
    for bar, chord in enumerate(chords):
        start = bar * 2.0
        for frequency in chord:
            _overlay(
                track,
                _tone(
                    frequency,
                    2.0,
                    wave="sine",
                    volume=0.055,
                    attack=0.12,
                    release=0.28,
                ),
                start,
            )
        for step in range(8):
            frequency = chord[step % 3] * (2.0 if step in (3, 7) else 1.0)
            _overlay(
                track,
                _tone(
                    frequency,
                    0.22,
                    wave="triangle",
                    volume=0.11,
                    release=0.12,
                ),
                start + step * 0.25,
            )
        _overlay(
            track,
            _tone(chord[0] / 2.0, 0.65, volume=0.12, release=0.25),
            start,
        )
        _overlay(
            track,
            _tone(chord[0] / 2.0, 0.55, volume=0.09, release=0.22),
            start + 1.0,
        )
    return np.clip(track, -0.9, 0.9)


def _game_music(rng: np.random.Generator) -> np.ndarray:
    """6.4-second energetic chiptune loop for active play."""

    beat = 0.20
    steps = 32
    duration = beat * steps
    track = np.zeros(int(SAMPLE_RATE * duration), dtype=np.float32)
    bass_notes = (130.81, 130.81, 110.00, 110.00, 87.31, 87.31, 98.00, 98.00)
    melody = (
        523.25,
        659.25,
        783.99,
        659.25,
        587.33,
        698.46,
        880.00,
        698.46,
    )
    for step in range(steps):
        start = step * beat
        _overlay(
            track,
            _tone(
                melody[step % len(melody)],
                beat * 0.78,
                wave="square",
                volume=0.075,
                release=0.045,
            ),
            start,
        )
        if step % 2 == 0:
            _overlay(
                track,
                _tone(
                    bass_notes[(step // 4) % len(bass_notes)],
                    beat * 1.8,
                    wave="triangle",
                    volume=0.16,
                    release=0.10,
                ),
                start,
            )
            _overlay(
                track,
                _tone(
                    125.0,
                    0.11,
                    end_frequency=45.0,
                    volume=0.19,
                    release=0.09,
                ),
                start,
            )
        _overlay(
            track,
            _noise(0.035, volume=0.045, rng=rng, release=0.03),
            start + beat * 0.5,
        )
    return np.clip(track, -0.92, 0.92)


def _build_effects(rng: np.random.Generator) -> dict[str, np.ndarray]:
    jump = _tone(310, 0.19, end_frequency=760, volume=0.55, release=0.055)
    boost = _mix(
        _tone(150, 0.38, end_frequency=920, wave="saw", volume=0.34),
        _tone(300, 0.38, end_frequency=1500, wave="sine", volume=0.25),
    )
    attack = _mix(
        _tone(260, 0.22, end_frequency=85, wave="saw", volume=0.42),
        _noise(0.16, volume=0.28, rng=rng, release=0.14),
    )
    shield = _mix(
        _sequence([(523.25, 0.08), (783.99, 0.09), (1046.50, 0.18)], volume=0.34),
        _tone(420, 0.36, end_frequency=880, volume=0.18),
    )
    destroy = _mix(
        _noise(0.24, volume=0.48, rng=rng, release=0.22),
        _tone(180, 0.26, end_frequency=55, wave="square", volume=0.25),
    )
    hit = _mix(
        _noise(0.20, volume=0.45, rng=rng, release=0.18),
        _tone(105, 0.24, end_frequency=65, volume=0.38),
    )
    return {
        "click": _sequence([(659.25, 0.045), (880.00, 0.065)], wave="square", volume=0.25),
        "start": _sequence([(523.25, 0.07), (659.25, 0.07), (783.99, 0.07), (1046.50, 0.16)], wave="triangle", volume=0.38),
        "score": _sequence([(880.00, 0.055), (1318.51, 0.12)], wave="triangle", volume=0.38),
        "jump": jump,
        "boost": boost,
        "attack": attack,
        "shield": shield,
        "destroy": destroy,
        "shield_block": _mix(
            _tone(960, 0.17, end_frequency=1450, volume=0.35),
            _tone(1280, 0.20, end_frequency=850, volume=0.24),
        ),
        "hit": hit,
        "death": _sequence(
            [(440.00, 0.16), (349.23, 0.16), (261.63, 0.20), (130.81, 0.42)],
            wave="triangle",
            volume=0.44,
        ),
        "pause": _sequence([(659.25, 0.09), (440.00, 0.14)], wave="triangle", volume=0.28),
        "resume": _sequence([(440.00, 0.09), (659.25, 0.14)], wave="triangle", volume=0.28),
        "error": _sequence([(180.00, 0.09), (150.00, 0.14)], wave="square", volume=0.24),
    }


class AudioManager:
    """Play background loops and effects, or silently no-op on audio failure."""

    MUSIC_VOLUME = settings.AUDIO_MUSIC_VOLUME
    PAUSED_MUSIC_VOLUME = settings.AUDIO_PAUSED_MUSIC_VOLUME

    def __init__(self) -> None:
        self.enabled = False
        self.muted = False
        self.paused = False
        self.master_volume = settings.AUDIO_MASTER_VOLUME
        self.current_music: str | None = None
        self.error: str | None = None
        self.sounds: dict[str, pygame.mixer.Sound] = {}
        self.music: dict[str, pygame.mixer.Sound] = {}
        self.music_channel: pygame.mixer.Channel | None = None
        try:
            mixer_state = pygame.mixer.get_init()
            expected_mixer = (
                SAMPLE_RATE,
                settings.AUDIO_SAMPLE_SIZE,
                settings.AUDIO_CHANNELS,
            )
            if mixer_state != expected_mixer:
                if mixer_state is not None:
                    pygame.mixer.quit()
                pygame.mixer.init(
                    frequency=SAMPLE_RATE,
                    size=settings.AUDIO_SAMPLE_SIZE,
                    channels=settings.AUDIO_CHANNELS,
                    buffer=settings.AUDIO_BUFFER,
                )
            pygame.mixer.set_num_channels(settings.AUDIO_MIXER_CHANNELS)
            pygame.mixer.set_reserved(settings.AUDIO_RESERVED_CHANNELS)
            self.music_channel = pygame.mixer.Channel(0)
            rng = np.random.default_rng(20260717)
            self.music = {
                "menu": _sound_from_mono(_menu_music()),
                "game": _sound_from_mono(_game_music(rng)),
            }
            self.sounds = {
                name: _sound_from_mono(samples)
                for name, samples in _build_effects(rng).items()
            }
            self.enabled = True
        except (pygame.error, ValueError, RuntimeError) as error:
            self.error = str(error)

    def play_music(self, name: str | None) -> None:
        if not self.enabled or self.music_channel is None:
            return
        if name == self.current_music:
            return
        if name is None:
            self.music_channel.fadeout(350)
            self.current_music = None
            return
        sound = self.music.get(name)
        if sound is None:
            return
        self.music_channel.play(sound, loops=-1, fade_ms=400)
        self.current_music = name
        self._apply_music_volume()

    def play(self, name: str) -> None:
        if not self.enabled or self.muted:
            return
        sound = self.sounds.get(name)
        if sound is None:
            return
        channel = pygame.mixer.find_channel(force=True)
        if channel is not None:
            channel.set_volume(
                self.master_volume * settings.AUDIO_EFFECTS_VOLUME
            )
            channel.play(sound)

    def set_paused(self, paused: bool) -> None:
        if paused == self.paused:
            self._apply_music_volume()
            return
        self.paused = paused
        self._apply_music_volume()
        self.play("pause" if paused else "resume")

    def toggle_mute(self) -> bool:
        self.muted = not self.muted
        self._apply_music_volume()
        return self.muted

    def set_volume(self, volume: float) -> float:
        self.master_volume = max(
            settings.AUDIO_MIN_VOLUME,
            min(settings.AUDIO_MAX_VOLUME, float(volume)),
        )
        self._apply_music_volume()
        return self.master_volume

    def adjust_volume(self, delta: float) -> float:
        self.muted = False
        return self.set_volume(self.master_volume + float(delta))

    @property
    def volume_percent(self) -> int:
        return round(self.master_volume * 100)

    def shutdown(self) -> None:
        if self.enabled:
            pygame.mixer.stop()

    def _apply_music_volume(self) -> None:
        if self.music_channel is None:
            return
        if self.muted:
            volume = 0.0
        elif self.paused:
            volume = self.PAUSED_MUSIC_VOLUME * self.master_volume
        else:
            volume = self.MUSIC_VOLUME * self.master_volume
        self.music_channel.set_volume(volume)
