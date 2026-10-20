# web-ai-demo2

ブラウザ内だけで動くAI画像生成デモ(お絵描きチャット)。

- すべての推論は閲覧者のブラウザ内(WebGPU)で実行。サーバー計算なし・API鍵などの秘密情報は同梱しない。
- モデル: Anima-Turbo v1.1 + 固定LoRA(Highres/Aesthetic Boost / Detail Tweaker / Blue Archive Style)
- エンジン: stable-diffusion.cpp (MIT) の WebAssembly/WebGPU ビルド
- モデルのダウンロード元は Hugging Face の公開リポジトリのみ。

## 帰属 / Credits

- [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) by leejet — MIT License
- [naidan](https://github.com/nwtgck/naidan) / browser-inference-core by Ryo Ota (nwtgck) — MIT License
- [Anima](https://huggingface.co/circlestone-labs/Anima) by CircleStone Labs
- LoRA作者各位(Civitai / Hugging Face 公開物・各モデルページのライセンスに従う)
