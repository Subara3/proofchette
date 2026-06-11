# Generate 16kHz/16bit/mono WAV files from terms.json sentences
# using the built-in Windows TTS voice (Microsoft Haruka, ja-JP).
# Note: synthetic speech, not a human voice -- stated explicitly in the article.
Add-Type -AssemblyName System.Speech

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$json = Get-Content (Join-Path $here "terms.json") -Encoding UTF8 | ConvertFrom-Json
$outDir = Join-Path $here "audio"
New-Item -ItemType Directory -Force $outDir | Out-Null

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoice("Microsoft Haruka Desktop")
$synth.Rate = 0

$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)

$i = 0
foreach ($t in $json.terms) {
    $path = Join-Path $outDir ("{0:d2}.wav" -f $i)
    $synth.SetOutputToWaveFile($path, $fmt)
    $synth.Speak($t.sentence_tts)
    $i++
}
$synth.SetOutputToNull()
$synth.Dispose()
Write-Output "generated $i wav files in $outDir"
