"""5-bit quantized cache for fast repeated character lookups."""

from typing import Dict, Optional


class QuantizedCache:
    """
    Maps 6D sampling vectors to characters via quantized integer keys.
    Each dimension is quantized to 5 bits (32 levels), giving a 30-bit key.
    """

    def __init__(self, bits: int = 5):
        self.bits = bits
        self.range = 2 ** bits
        self._cache: Dict[int, str] = {}
        self.hits: int = 0
        self.misses: int = 0

    def _make_key(self, vector) -> int:
        """Quantize a vector to a single integer key."""
        key = 0
        for v in vector:
            quantized = min(self.range - 1, max(0, int(float(v) * self.range)))
            key = (key << self.bits) | quantized
        return key

    def get(self, vector) -> Optional[str]:
        """Look up cached character. Returns None on miss."""
        key = self._make_key(vector)
        result = self._cache.get(key)
        if result is not None:
            self.hits += 1
        else:
            self.misses += 1
        return result

    def put(self, vector, character: str):
        """Store a character mapping for a vector."""
        key = self._make_key(vector)
        self._cache[key] = character

    def stats(self) -> dict:
        total = self.hits + self.misses
        return {
            "hits": self.hits,
            "misses": self.misses,
            "hit_rate": self.hits / total if total > 0 else 0,
            "entries": len(self._cache),
        }
