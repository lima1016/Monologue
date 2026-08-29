from pathlib import Path
from kokoro_onnx import Kokoro

root = Path(__file__).parent
k = Kokoro(str(root / "kokoro-v1.0.onnx"), str(root / "voices-v1.0.bin"))
names = sorted(k.get_voices())
print(f"total: {len(names)}")
for n in names:
    print(" ", n)
