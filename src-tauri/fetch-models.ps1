# Fetch the Whisper models used by the offline desktop build.
#
# Only the files transformers.js actually requests are downloaded: the config /
# tokenizer JSON, and the two q8 ONNX graphs (encoder + merged decoder). The
# other ONNX variants in those repos are hundreds of MB and are never loaded.
#
# Layout matches what the library expects for a local model:
#   <localModelPath>/<modelId>/<file>     (no revision in the path)
# which the build stages as  app-root/models/onnx-community/<model>/...
#
# Revisions are pinned so a rebuild produces the same files.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $PSScriptRoot "models"

$models = @(
  @{ id = "onnx-community/whisper-tiny_timestamped";  rev = "517244293732ee2d58139af5814231b7e6830a0d" },
  @{ id = "onnx-community/whisper-base_timestamped";  rev = "608c49e61301901684bc36cac8f74b95ff6b5a8e" },
  @{ id = "onnx-community/whisper-small_timestamped"; rev = "65caa70f294b46e1c33ff820aae6b16d048ab818" }
)

$files = @(
  "added_tokens.json",
  "config.json",
  "generation_config.json",
  "normalizer.json",
  "preprocessor_config.json",
  "quantize_config.json",
  "special_tokens_map.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "vocab.json",
  "onnx/encoder_model_quantized.onnx",
  "onnx/decoder_model_merged_quantized.onnx"
)

$total = 0
foreach ($m in $models) {
  foreach ($f in $files) {
    $out = Join-Path (Join-Path $dest $m.id) ($f -replace "/", "\")
    $dir = Split-Path -Parent $out
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    if (Test-Path -LiteralPath $out) {
      Write-Host "have  $($m.id)/$f"
      continue
    }
    $url = "https://huggingface.co/$($m.id)/resolve/$($m.rev)/$f"
    Write-Host "fetch $($m.id)/$f"
    Invoke-WebRequest -Uri $url -OutFile $out -TimeoutSec 900
    $total += (Get-Item -LiteralPath $out).Length
  }
}

$size = (Get-ChildItem -Recurse -File $dest | Measure-Object -Property Length -Sum).Sum
Write-Host ("`nModels staged in {0} ({1:N1} MB)" -f $dest, ($size / 1MB))
