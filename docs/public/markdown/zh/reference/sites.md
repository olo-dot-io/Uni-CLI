<!-- 由 docs/zh/reference/sites.md 生成。不要直接编辑此副本。 -->

# 站点目录

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/reference/sites
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/reference/sites.md
- 栏目: 参考
- 上级: 参考 (/zh/reference/)

这个页面由 `docs/site-index.json` 生成，展示 Uni-CLI 当前能发现和运行的站点、桌面工具、服务和外部 CLI。

## 生成的站点目录

这个目录来自适配器 manifest：235 个站点，1448 条命令。

| 站点 | 接口类型 | 命令数 | 认证 | 示例命令 |
| --- | --- | ---: | --- | --- |
| 1688 | web-api | 5 | 是 | unicli 1688 item<br>unicli 1688 search<br>unicli 1688 store |
| 36kr | web-api | 5 | 否 | unicli 36kr article<br>unicli 36kr hot<br>unicli 36kr latest |
| 51job | web-api | 4 | 是 | unicli 51job search<br>unicli 51job hot<br>unicli 51job detail |
| adguardhome | service | 5 | 否 | unicli adguardhome add-rule<br>unicli adguardhome rules<br>unicli adguardhome stats |
| amazon | web-api | 8 | 是 | unicli amazon bestsellers<br>unicli amazon discussion<br>unicli amazon movers-shakers |
| antigravity | web-api | 16 | 否 | unicli antigravity extract-code<br>unicli antigravity watch<br>unicli antigravity ask |
| apple-music | browser | 1 | 是 | unicli apple-music rate-album |
| apple-notes | desktop | 3 | 否 | unicli apple-notes list<br>unicli apple-notes read<br>unicli apple-notes search |
| apple-podcasts | web-api | 3 | 否 | unicli apple-podcasts episodes<br>unicli apple-podcasts search<br>unicli apple-podcasts top |
| arxiv | web-api | 3 | 否 | unicli arxiv paper<br>unicli arxiv search<br>unicli arxiv trending |
| audacity | desktop | 8 | 否 | unicli audacity convert<br>unicli audacity effects<br>unicli audacity info |
| autoagent | bridge | 1 | 否 | unicli autoagent eval-run |
| aws | bridge | 1 | 否 | unicli aws s3-ls |
| az | bridge | 1 | 否 | unicli az account |
| baidu | web-api | 2 | 是 | unicli baidu hot<br>unicli baidu search |
| baidu-scholar | web-api | 1 | 否 | unicli baidu-scholar search |
| band | web-api | 4 | 是 | unicli band bands<br>unicli band mentions<br>unicli band post |
| barchart | web-api | 4 | 是 | unicli barchart flow<br>unicli barchart greeks<br>unicli barchart options |
| bbc | web-api | 4 | 否 | unicli bbc news<br>unicli bbc technology<br>unicli bbc top |
| bilibili | web-api | 20 | 是 | unicli bilibili coin<br>unicli bilibili dynamic<br>unicli bilibili favorites |
| binance | web-api | 13 | 否 | unicli binance asks<br>unicli binance depth<br>unicli binance gainers |
| blender | desktop | 13 | 否 | unicli blender animation<br>unicli blender camera<br>unicli blender convert |
| bloomberg | web-api | 10 | 否 | unicli bloomberg businessweek<br>unicli bloomberg economics<br>unicli bloomberg feeds |
| bluesky | web-api | 12 | 是 | unicli bluesky feeds<br>unicli bluesky followers<br>unicli bluesky following |
| boss | web-api | 14 | 是 | unicli boss batchgreet<br>unicli boss chatlist<br>unicli boss chatmsg |
| chaoxing | web-api | 2 | 是 | unicli chaoxing assignments<br>unicli chaoxing exams |
| chatgpt | web-api | 15 | 是 | unicli chatgpt image<br>unicli chatgpt ask<br>unicli chatgpt send |
| chatwise | web-api | 16 | 否 | unicli chatwise history<br>unicli chatwise export<br>unicli chatwise ask |
| chrome | desktop | 2 | 否 | unicli chrome bookmarks<br>unicli chrome tabs |
| claude-code | bridge | 1 | 否 | unicli claude-code version |
| cloudcompare | desktop | 4 | 否 | unicli cloudcompare compare<br>unicli cloudcompare convert<br>unicli cloudcompare info |
| cnki | web-api | 1 | 否 | unicli cnki search |
| cnn | web-api | 2 | 否 | unicli cnn technology<br>unicli cnn top |
| cocoapods | web-api | 2 | 否 | unicli cocoapods info<br>unicli cocoapods search |
| codex | web-api | 17 | 否 | unicli codex extract-diff<br>unicli codex history<br>unicli codex export |
| codex-cli | bridge | 1 | 否 | unicli codex-cli version |
| coinbase | web-api | 2 | 否 | unicli coinbase prices<br>unicli coinbase rates |
| comfyui | service | 4 | 否 | unicli comfyui generate<br>unicli comfyui history<br>unicli comfyui nodes |
| coupang | web-api | 3 | 是 | unicli coupang add-to-cart<br>unicli coupang hot<br>unicli coupang search |
| crates-io | web-api | 3 | 否 | unicli crates-io info<br>unicli crates-io search<br>unicli crates-io versions |
| ctrip | web-api | 2 | 否 | unicli ctrip hot<br>unicli ctrip search |
| cua | bridge | 2 | 否 | unicli cua bench-list<br>unicli cua bench-run |
| cursor | web-api | 18 | 否 | unicli cursor composer<br>unicli cursor extract-code<br>unicli cursor export |
| dangdang | web-api | 2 | 是 | unicli dangdang hot<br>unicli dangdang search |
| deepseek | web-api | 7 | 是 | unicli deepseek chat<br>unicli deepseek models<br>unicli deepseek ask |
| devto | web-api | 5 | 否 | unicli devto latest<br>unicli devto search<br>unicli devto tag |
| dianping | web-api | 2 | 是 | unicli dianping hot<br>unicli dianping search |
| dictionary | web-api | 3 | 否 | unicli dictionary examples<br>unicli dictionary search<br>unicli dictionary synonyms |
| dingtalk | bridge | 8 | 否 | unicli dingtalk version<br>unicli dingtalk open-app<br>unicli dingtalk status-app |
| discord-app | web-api | 15 | 否 | unicli discord-app servers<br>unicli discord-app channels<br>unicli discord-app read |
| docker | desktop | 7 | 否 | unicli docker build<br>unicli docker images<br>unicli docker logs |
| docker-hub | web-api | 3 | 否 | unicli docker-hub info<br>unicli docker-hub search<br>unicli docker-hub tags |
| doctl | bridge | 1 | 否 | unicli doctl droplets |
| douban | web-api | 12 | 是 | unicli douban book-hot<br>unicli douban download<br>unicli douban group-hot |
| doubao | web-api | 9 | 是 | unicli doubao ask<br>unicli doubao new<br>unicli doubao status |
| doubao-web | web-api | 9 | 是 | unicli doubao-web ask<br>unicli doubao-web detail<br>unicli doubao-web history |
| douyin | web-api | 13 | 是 | unicli douyin activities<br>unicli douyin collections<br>unicli douyin delete |
| douyu | web-api | 2 | 是 | unicli douyu hot<br>unicli douyu search |
| drawio | desktop | 1 | 否 | unicli drawio export |
| eastmoney | web-api | 18 | 否 | unicli eastmoney fund<br>unicli eastmoney hot<br>unicli eastmoney market |
| ele | web-api | 2 | 是 | unicli ele hot<br>unicli ele search |
| excel | desktop | 7 | 否 | unicli excel insert-image<br>unicli excel insert-link<br>unicli excel list |
| exchangerate | web-api | 2 | 否 | unicli exchangerate convert<br>unicli exchangerate list |
| facebook | web-api | 12 | 是 | unicli facebook add-friend<br>unicli facebook events<br>unicli facebook feed |
| feishu | bridge | 4 | 否 | unicli feishu calendar<br>unicli feishu docs<br>unicli feishu send |
| ffmpeg | desktop | 11 | 否 | unicli ffmpeg compress<br>unicli ffmpeg concat<br>unicli ffmpeg convert |
| figma | browser | 8 | 是 | unicli figma export-selected<br>unicli figma open-app<br>unicli figma status-app |
| flyctl | bridge | 1 | 否 | unicli flyctl apps |
| freecad | desktop | 15 | 否 | unicli freecad assembly<br>unicli freecad bom<br>unicli freecad boolean |
| futu | web-api | 2 | 是 | unicli futu hot<br>unicli futu quote |
| gcloud | bridge | 1 | 否 | unicli gcloud projects |
| gemini | web-api | 5 | 是 | unicli gemini ask<br>unicli gemini deep-research-result<br>unicli gemini deep-research |
| gh | bridge | 6 | 否 | unicli gh issue<br>unicli gh pr<br>unicli gh release |
| gimp | desktop | 12 | 否 | unicli gimp adjust<br>unicli gimp batch<br>unicli gimp convert |
| gitee | web-api | 4 | 否 | unicli gitee repos<br>unicli gitee search<br>unicli gitee trending |
| github-trending | web-api | 3 | 否 | unicli github-trending daily<br>unicli github-trending developers<br>unicli github-trending weekly |
| gitlab | web-api | 3 | 否 | unicli gitlab projects<br>unicli gitlab search<br>unicli gitlab trending |
| godot | desktop | 2 | 否 | unicli godot project-run<br>unicli godot scene-export |
| google | web-api | 4 | 否 | unicli google news<br>unicli google search<br>unicli google suggest |
| google-scholar | web-api | 3 | 否 | unicli google-scholar cite<br>unicli google-scholar profile<br>unicli google-scholar search |
| gov-law | web-api | 2 | 否 | unicli gov-law search<br>unicli gov-law recent |
| gov-policy | web-api | 2 | 否 | unicli gov-policy search<br>unicli gov-policy recent |
| grok | web-api | 1 | 是 | unicli grok ask |
| hackernews | web-api | 10 | 否 | unicli hackernews ask<br>unicli hackernews best<br>unicli hackernews comments |
| hermes | desktop | 3 | 否 | unicli hermes sessions-search<br>unicli hermes skills-list<br>unicli hermes skills-read |
| hf | web-api | 4 | 否 | unicli hf datasets<br>unicli hf models<br>unicli hf spaces |
| homebrew | web-api | 2 | 否 | unicli homebrew info<br>unicli homebrew search |
| huggingface-papers | web-api | 2 | 否 | unicli huggingface-papers daily<br>unicli huggingface-papers search |
| hupu | web-api | 7 | 是 | unicli hupu detail<br>unicli hupu hot<br>unicli hupu like |
| imagemagick | desktop | 6 | 否 | unicli imagemagick compare<br>unicli imagemagick composite<br>unicli imagemagick convert |
| imdb | web-api | 7 | 否 | unicli imdb box-office<br>unicli imdb person<br>unicli imdb reviews |
| imessage | desktop | 3 | 否 | unicli imessage contact<br>unicli imessage recent<br>unicli imessage search |
| infoq | web-api | 2 | 否 | unicli infoq articles<br>unicli infoq latest |
| inkscape | desktop | 3 | 否 | unicli inkscape convert<br>unicli inkscape export<br>unicli inkscape optimize |
| instagram | web-api | 26 | 是 | unicli instagram activity<br>unicli instagram comment<br>unicli instagram explore |
| ip-info | web-api | 1 | 否 | unicli ip-info lookup |
| itch-io | web-api | 3 | 否 | unicli itch-io popular<br>unicli itch-io search<br>unicli itch-io top |
| ithome | web-api | 3 | 否 | unicli ithome hot<br>unicli ithome latest<br>unicli ithome news |
| jd | web-api | 7 | 是 | unicli jd hot<br>unicli jd item<br>unicli jd search |
| jianyu | browser | 2 | 是 | unicli jianyu search<br>unicli jianyu detail |
| jike | browser | 10 | 是 | unicli jike feed<br>unicli jike notifications<br>unicli jike post |
| jimeng | web-api | 4 | 是 | unicli jimeng generate<br>unicli jimeng history<br>unicli jimeng new |
| jq | bridge | 2 | 否 | unicli jq format<br>unicli jq query |
| kdenlive | desktop | 3 | 否 | unicli kdenlive effects<br>unicli kdenlive info<br>unicli kdenlive render |
| ke | browser | 4 | 是 | unicli ke ershoufang<br>unicli ke xiaoqu<br>unicli ke zufang |
| krita | desktop | 4 | 否 | unicli krita batch<br>unicli krita convert<br>unicli krita export |
| kuaishou | web-api | 2 | 是 | unicli kuaishou hot<br>unicli kuaishou search |
| lark | bridge | 8 | 否 | unicli lark version<br>unicli lark open-app<br>unicli lark status-app |
| lesswrong | web-api | 15 | 否 | unicli lesswrong comments<br>unicli lesswrong curated<br>unicli lesswrong frontpage |
| libreoffice | desktop | 2 | 否 | unicli libreoffice convert<br>unicli libreoffice print |
| linear | web-api | 10 | 否 | unicli linear issue-create<br>unicli linear issue-list<br>unicli linear issue-update |
| linkedin | web-api | 4 | 是 | unicli linkedin jobs<br>unicli linkedin profile<br>unicli linkedin search |
| linux-do | web-api | 11 | 是 | unicli linux-do categories<br>unicli linux-do category<br>unicli linux-do feed |
| lobsters | web-api | 5 | 否 | unicli lobsters active<br>unicli lobsters hot<br>unicli lobsters newest |
| macos | desktop | 58 | 否 | unicli macos active-app<br>unicli macos apps-list<br>unicli macos apps |
| maimai | browser | 2 | 是 | unicli maimai search<br>unicli maimai search-talents |
| maoyan | web-api | 2 | 是 | unicli maoyan hot<br>unicli maoyan search |
| mastodon | web-api | 4 | 否 | unicli mastodon search<br>unicli mastodon timeline<br>unicli mastodon trending |
| medium | web-api | 5 | 否 | unicli medium article<br>unicli medium feed<br>unicli medium search |
| meituan | web-api | 1 | 是 | unicli meituan search |
| mermaid | desktop | 1 | 否 | unicli mermaid render |
| minimax | web-api | 3 | 是 | unicli minimax chat<br>unicli minimax models<br>unicli minimax tts |
| motion-studio | web-api | 1 | 否 | unicli motion-studio component-get |
| mubu | web-api | 6 | 是 | unicli mubu list<br>unicli mubu search<br>unicli mubu docs |
| musescore | desktop | 5 | 否 | unicli musescore convert<br>unicli musescore export<br>unicli musescore info |
| neonctl | bridge | 1 | 否 | unicli neonctl projects |
| netease-music | web-api | 17 | 否 | unicli netease-music hot<br>unicli netease-music playlist<br>unicli netease-music search |
| netlify | bridge | 1 | 否 | unicli netlify sites |
| notebooklm | web-api | 15 | 是 | unicli notebooklm current<br>unicli notebooklm get<br>unicli notebooklm history |
| notion | web-api | 18 | 是 | unicli notion databases<br>unicli notion pages<br>unicli notion search |
| novita | service | 3 | 否 | unicli novita generate<br>unicli novita models<br>unicli novita status |
| nowcoder | web-api | 16 | 是 | unicli nowcoder hot<br>unicli nowcoder trending<br>unicli nowcoder topics |
| npm | web-api | 4 | 否 | unicli npm downloads<br>unicli npm info<br>unicli npm search |
| npm-trends | web-api | 2 | 否 | unicli npm-trends compare<br>unicli npm-trends trending |
| nytimes | web-api | 2 | 否 | unicli nytimes search<br>unicli nytimes top |
| obs | service | 8 | 否 | unicli obs record-start<br>unicli obs record-stop<br>unicli obs scenes |
| obsidian | desktop | 10 | 否 | unicli obsidian daily<br>unicli obsidian open<br>unicli obsidian search |
| ollama | service | 4 | 否 | unicli ollama generate<br>unicli ollama list<br>unicli ollama models |
| ones | web-api | 11 | 是 | unicli ones enrich-tasks<br>unicli ones login<br>unicli ones logout |
| opencode | bridge | 1 | 否 | unicli opencode version |
| openharness | desktop | 2 | 否 | unicli openharness memory-read<br>unicli openharness skills-list |
| openrouter | web-api | 2 | 否 | unicli openrouter models<br>unicli openrouter search |
| pandoc | desktop | 1 | 否 | unicli pandoc convert |
| paperreview | web-api | 3 | 否 | unicli paperreview feedback<br>unicli paperreview review<br>unicli paperreview submit |
| perplexity | web-api | 8 | 是 | unicli perplexity ask<br>unicli perplexity open-app<br>unicli perplexity status-app |
| pexels | web-api | 2 | 是 | unicli pexels curated<br>unicli pexels search |
| pinduoduo | web-api | 2 | 是 | unicli pinduoduo hot<br>unicli pinduoduo search |
| pixiv | web-api | 6 | 是 | unicli pixiv detail<br>unicli pixiv download<br>unicli pixiv illusts |
| powerchina | web-api | 1 | 是 | unicli powerchina search |
| powerpoint | desktop | 7 | 否 | unicli powerpoint add-slide<br>unicli powerpoint insert-image<br>unicli powerpoint insert-link |
| producthunt | web-api | 5 | 否 | unicli producthunt browse<br>unicli producthunt hot<br>unicli producthunt posts |
| pscale | bridge | 1 | 否 | unicli pscale databases |
| pypi | web-api | 3 | 否 | unicli pypi info<br>unicli pypi search<br>unicli pypi versions |
| quark | web-api | 8 | 是 | unicli quark ls<br>unicli quark search<br>unicli quark mkdir |
| qweather | web-api | 2 | 否 | unicli qweather forecast<br>unicli qweather now |
| railway | bridge | 1 | 否 | unicli railway deploy |
| reddit | web-api | 20 | 是 | unicli reddit comment<br>unicli reddit comments<br>unicli reddit read |
| renderdoc | desktop | 2 | 否 | unicli renderdoc capture-list<br>unicli renderdoc frame-export |
| replicate | web-api | 3 | 是 | unicli replicate run<br>unicli replicate search<br>unicli replicate trending |
| reuters | web-api | 4 | 否 | unicli reuters article<br>unicli reuters latest<br>unicli reuters search |
| shotcut | desktop | 3 | 否 | unicli shotcut effects<br>unicli shotcut info<br>unicli shotcut render |
| sinablog | browser | 4 | 否 | unicli sinablog article<br>unicli sinablog hot<br>unicli sinablog search |
| sinafinance | web-api | 5 | 否 | unicli sinafinance market<br>unicli sinafinance news<br>unicli sinafinance rolling-news |
| sketch | desktop | 3 | 否 | unicli sketch artboards<br>unicli sketch export<br>unicli sketch symbols |
| slack | web-api | 14 | 是 | unicli slack channels<br>unicli slack messages<br>unicli slack post |
| slay-the-spire-ii | service | 6 | 否 | unicli slay-the-spire-ii deck<br>unicli slay-the-spire-ii end-turn<br>unicli slay-the-spire-ii map |
| slock | browser | 1 | 是 | unicli slock servers |
| smzdm | web-api | 3 | 是 | unicli smzdm article<br>unicli smzdm hot<br>unicli smzdm search |
| spotify | web-api | 23 | 是 | unicli spotify now-playing<br>unicli spotify playlists<br>unicli spotify search |
| sspai | web-api | 2 | 否 | unicli sspai hot<br>unicli sspai latest |
| stackoverflow | web-api | 6 | 否 | unicli stackoverflow bounties<br>unicli stackoverflow hot<br>unicli stackoverflow question |
| stagehand | bridge | 1 | 否 | unicli stagehand wrap-observe |
| steam | web-api | 6 | 否 | unicli steam app-details<br>unicli steam new-releases<br>unicli steam search |
| substack | web-api | 4 | 否 | unicli substack feed<br>unicli substack publication<br>unicli substack search |
| supabase | bridge | 1 | 否 | unicli supabase projects |
| taobao | browser | 6 | 是 | unicli taobao hot<br>unicli taobao search<br>unicli taobao detail |
| tdx | web-api | 1 | 是 | unicli tdx hot-rank |
| techcrunch | web-api | 2 | 否 | unicli techcrunch latest<br>unicli techcrunch search |
| theverge | web-api | 2 | 否 | unicli theverge latest<br>unicli theverge search |
| threads | web-api | 2 | 是 | unicli threads hot<br>unicli threads search |
| ths | web-api | 1 | 是 | unicli ths hot-rank |
| tieba | web-api | 4 | 否 | unicli tieba hot<br>unicli tieba posts<br>unicli tieba read |
| tiktok | web-api | 16 | 是 | unicli tiktok comment<br>unicli tiktok explore<br>unicli tiktok follow |
| toutiao | web-api | 3 | 是 | unicli toutiao hot<br>unicli toutiao search<br>unicli toutiao articles |
| twitch | web-api | 4 | 是 | unicli twitch games<br>unicli twitch search<br>unicli twitch streams |
| twitter | web-api | 38 | 是 | unicli twitter lists<br>unicli twitter media<br>unicli twitter mentions |
| uiverse | web-api | 2 | 否 | unicli uiverse code<br>unicli uiverse preview |
| unsplash | web-api | 2 | 否 | unicli unsplash random<br>unicli unsplash search |
| v2ex | web-api | 12 | 是 | unicli v2ex daily<br>unicli v2ex hot<br>unicli v2ex latest |
| vercel | bridge | 1 | 否 | unicli vercel list |
| vscode | desktop | 10 | 否 | unicli vscode extensions<br>unicli vscode install-ext<br>unicli vscode open |
| wanfang | web-api | 1 | 否 | unicli wanfang search |
| web | web-api | 1 | 否 | unicli web read |
| wechat-channels | web-api | 2 | 是 | unicli wechat-channels hot<br>unicli wechat-channels search |
| weibo | web-api | 10 | 是 | unicli weibo comments<br>unicli weibo feed<br>unicli weibo hot |
| weixin | browser | 6 | 是 | unicli weixin article<br>unicli weixin download<br>unicli weixin hot |
| weread | web-api | 8 | 是 | unicli weread book<br>unicli weread highlights<br>unicli weread notebooks |
| wikipedia | web-api | 5 | 否 | unicli wikipedia random<br>unicli wikipedia search<br>unicli wikipedia summary |
| wiremock | service | 5 | 否 | unicli wiremock create-stub<br>unicli wiremock delete-stub<br>unicli wiremock reset |
| word | desktop | 7 | 否 | unicli word insert-image<br>unicli word insert-link<br>unicli word insert-text |
| wrangler | bridge | 1 | 否 | unicli wrangler list |
| xianyu | web-api | 3 | 是 | unicli xianyu chat<br>unicli xianyu item<br>unicli xianyu search |
| xiaoe | web-api | 5 | 是 | unicli xiaoe catalog<br>unicli xiaoe content<br>unicli xiaoe courses |
| xiaohongshu | web-api | 22 | 是 | unicli xiaohongshu feed<br>unicli xiaohongshu follow<br>unicli xiaohongshu hashtag |
| xiaoyuzhou | web-api | 5 | 是 | unicli xiaoyuzhou episode<br>unicli xiaoyuzhou podcast-episodes<br>unicli xiaoyuzhou podcast |
| xueqiu | web-api | 14 | 是 | unicli xueqiu comments<br>unicli xueqiu earnings-date<br>unicli xueqiu feed |
| yahoo-finance | web-api | 3 | 否 | unicli yahoo-finance quote<br>unicli yahoo-finance search<br>unicli yahoo-finance trending |
| ycombinator | web-api | 1 | 否 | unicli ycombinator launches |
| yollomi | web-api | 12 | 是 | unicli yollomi background<br>unicli yollomi edit<br>unicli yollomi face-swap |
| youtube | web-api | 16 | 是 | unicli youtube playlist<br>unicli youtube shorts<br>unicli youtube trending |
| yt-dlp | bridge | 4 | 否 | unicli yt-dlp download<br>unicli yt-dlp extract-audio<br>unicli yt-dlp info |
| yuanbao | web-api | 3 | 是 | unicli yuanbao ask<br>unicli yuanbao new<br>unicli yuanbao shared |
| zhihu | web-api | 24 | 是 | unicli zhihu answer<br>unicli zhihu answers<br>unicli zhihu article |
| zoom | desktop | 3 | 否 | unicli zoom join<br>unicli zoom start<br>unicli zoom toggle-mute |
| zotero | service | 8 | 否 | unicli zotero add-note<br>unicli zotero add-tag<br>unicli zotero collections |
| zsxq | web-api | 5 | 是 | unicli zsxq dynamics<br>unicli zsxq groups<br>unicli zsxq search |
| chatgpt-app | web-api | 8 | 否 | unicli chatgpt-app ask<br>unicli chatgpt-app send<br>unicli chatgpt-app read |
| doubao-app | web-api | 13 | 否 | unicli doubao-app ask<br>unicli doubao-app send<br>unicli doubao-app read |
| logseq | web-api | 7 | 否 | unicli logseq open-app<br>unicli logseq status-app<br>unicli logseq dump |
| typora | web-api | 7 | 否 | unicli typora open-app<br>unicli typora status-app<br>unicli typora dump |
| postman | web-api | 7 | 否 | unicli postman open-app<br>unicli postman status-app<br>unicli postman dump |
| insomnia | web-api | 7 | 否 | unicli insomnia open-app<br>unicli insomnia status-app<br>unicli insomnia dump |
| bitwarden | web-api | 7 | 否 | unicli bitwarden open-app<br>unicli bitwarden status-app<br>unicli bitwarden dump |
| signal | web-api | 7 | 否 | unicli signal open-app<br>unicli signal status-app<br>unicli signal dump |
| whatsapp | web-api | 7 | 否 | unicli whatsapp open-app<br>unicli whatsapp status-app<br>unicli whatsapp dump |
| teams | web-api | 7 | 否 | unicli teams open-app<br>unicli teams status-app<br>unicli teams dump |
| todoist | web-api | 7 | 否 | unicli todoist open-app<br>unicli todoist status-app<br>unicli todoist dump |
| github-desktop | web-api | 7 | 否 | unicli github-desktop open-app<br>unicli github-desktop status-app<br>unicli github-desktop dump |
| gitkraken | web-api | 7 | 否 | unicli gitkraken open-app<br>unicli gitkraken status-app<br>unicli gitkraken dump |
| docker-desktop | web-api | 7 | 否 | unicli docker-desktop open-app<br>unicli docker-desktop status-app<br>unicli docker-desktop dump |
| lm-studio | web-api | 7 | 否 | unicli lm-studio open-app<br>unicli lm-studio status-app<br>unicli lm-studio dump |
| claude | web-api | 7 | 否 | unicli claude open-app<br>unicli claude status-app<br>unicli claude dump |
| wechat-work | web-api | 7 | 否 | unicli wechat-work open-app<br>unicli wechat-work status-app<br>unicli wechat-work dump |
| zoom-app | web-api | 7 | 否 | unicli zoom-app open-app<br>unicli zoom-app status-app<br>unicli zoom-app dump |
| evernote-app | web-api | 7 | 否 | unicli evernote-app open-app<br>unicli evernote-app status-app<br>unicli evernote-app dump |

## 怎么读这个目录

- **Web API**：优先走 HTTP、Cookie、公开端点或轻量请求。
- **浏览器**：需要真实页面、CDP、截图、点击、输入或网络拦截。
- **桌面**：调用本机应用或本地子进程。
- **桥接**：复用已经安装的外部 CLI。
- **服务**：本地或云端服务接口。

目录里的命令名保持英文，因为它们就是实际 CLI 命令。中文页只翻译解释文字，不改命令合同。
