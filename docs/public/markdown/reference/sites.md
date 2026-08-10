<!-- Generated from docs/reference/sites.md. Do not edit this copy directly. -->

# Operation Catalog

- Canonical: https://olo-dot-io.github.io/Uni-CLI/reference/sites
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/reference/sites.md
- Section: Reference
- Parent: Reference (/reference/)

Uni-CLI publishes the same generated operation manifest to the docs site and
the command-line discovery tools. Search by site or command, filter by
interface, personal content, or authentication, then expand a site to inspect
every registered operation. Each row includes a matching `unicli describe`
command.

The command-line equivalent supports the same common paths.

```bash
unicli list --site <site>
unicli list --personalized
unicli search "<intent>" --personalized
```

## Generated Site Catalog

This catalog is generated from the adapter manifest: 337 sites, 1890 commands.

Run `unicli list --personalized` for every current-user operation, or add `--personalized` to an intent search.

| Site | Surface | Commands | Personalized | Auth | Example commands |
| --- | --- | ---: | ---: | --- | --- |
| 12306 | web-api | 3 | 0 | no | unicli 12306 price<br>unicli 12306 stations<br>unicli 12306 trains |
| 1688 | web-api | 5 | 0 | yes | unicli 1688 item<br>unicli 1688 search<br>unicli 1688 store |
| 36kr | web-api | 5 | 0 | no | unicli 36kr article<br>unicli 36kr hot<br>unicli 36kr latest |
| adguardhome | service | 5 | 0 | no | unicli adguardhome add-rule<br>unicli adguardhome rules<br>unicli adguardhome stats |
| amazon | web-api | 8 | 0 | yes | unicli amazon bestsellers<br>unicli amazon discussion<br>unicli amazon movers-shakers |
| apple-notes | desktop | 3 | 0 | no | unicli apple-notes list<br>unicli apple-notes read<br>unicli apple-notes search |
| apple-podcasts | web-api | 3 | 0 | no | unicli apple-podcasts episodes<br>unicli apple-podcasts search<br>unicli apple-podcasts top |
| arxiv | web-api | 7 | 0 | no | unicli arxiv download<br>unicli arxiv paper<br>unicli arxiv trending |
| audacity | desktop | 8 | 0 | no | unicli audacity convert<br>unicli audacity effects<br>unicli audacity info |
| autoagent | bridge | 1 | 0 | no | unicli autoagent eval-run |
| aws | bridge | 1 | 0 | no | unicli aws s3-ls |
| baidu | web-api | 2 | 0 | yes | unicli baidu hot<br>unicli baidu search |
| band | web-api | 4 | 1 | yes | unicli band mentions<br>unicli band bands<br>unicli band post |
| barchart | web-api | 4 | 0 | yes | unicli barchart flow<br>unicli barchart greeks<br>unicli barchart options |
| bbc | web-api | 5 | 0 | no | unicli bbc news<br>unicli bbc technology<br>unicli bbc top |
| bilibili | web-api | 20 | 7 | yes | unicli bilibili favorites<br>unicli bilibili feed<br>unicli bilibili following |
| binance | web-api | 13 | 0 | no | unicli binance asks<br>unicli binance depth<br>unicli binance gainers |
| blender | desktop | 13 | 0 | no | unicli blender animation<br>unicli blender camera<br>unicli blender convert |
| bloomberg | web-api | 10 | 0 | no | unicli bloomberg businessweek<br>unicli bloomberg economics<br>unicli bloomberg feeds |
| bluesky | web-api | 16 | 2 | yes | unicli bluesky likes<br>unicli bluesky notifications<br>unicli bluesky feeds |
| boss | web-api | 14 | 1 | yes | unicli boss recommend<br>unicli boss batchgreet<br>unicli boss chatlist |
| brave | web-api | 1 | 0 | no | unicli brave search |
| chaoxing | web-api | 2 | 0 | yes | unicli chaoxing assignments<br>unicli chaoxing exams |
| chrome | desktop | 2 | 0 | no | unicli chrome bookmarks<br>unicli chrome tabs |
| claude-code | bridge | 1 | 0 | no | unicli claude-code version |
| cloudcompare | desktop | 4 | 0 | no | unicli cloudcompare compare<br>unicli cloudcompare convert<br>unicli cloudcompare info |
| cnn | web-api | 2 | 0 | no | unicli cnn technology<br>unicli cnn top |
| cocoapods | web-api | 2 | 0 | no | unicli cocoapods info<br>unicli cocoapods search |
| codex-cli | bridge | 1 | 0 | no | unicli codex-cli version |
| coinbase | web-api | 2 | 0 | no | unicli coinbase prices<br>unicli coinbase rates |
| comfyui | service | 4 | 0 | no | unicli comfyui generate<br>unicli comfyui history<br>unicli comfyui nodes |
| coupang | web-api | 4 | 0 | yes | unicli coupang add-to-cart<br>unicli coupang hot<br>unicli coupang search |
| crates-io | web-api | 3 | 0 | no | unicli crates-io info<br>unicli crates-io search<br>unicli crates-io versions |
| danbooru | web-api | 8 | 0 | no | unicli danbooru artists<br>unicli danbooru comments<br>unicli danbooru detail |
| dangdang | web-api | 2 | 0 | yes | unicli dangdang hot<br>unicli dangdang search |
| deepseek | web-api | 9 | 1 | yes | unicli deepseek history<br>unicli deepseek chat<br>unicli deepseek models |
| defuddle | web-api | 1 | 0 | no | unicli defuddle read |
| devto | web-api | 6 | 0 | no | unicli devto latest<br>unicli devto search<br>unicli devto tag |
| dianping | web-api | 3 | 0 | yes | unicli dianping hot<br>unicli dianping search<br>unicli dianping shop |
| dictionary | web-api | 3 | 0 | no | unicli dictionary examples<br>unicli dictionary search<br>unicli dictionary synonyms |
| dingtalk | bridge | 8 | 0 | no | unicli dingtalk version<br>unicli dingtalk open-app<br>unicli dingtalk status-app |
| docker | desktop | 7 | 0 | no | unicli docker build<br>unicli docker images<br>unicli docker logs |
| docker-hub | web-api | 3 | 0 | no | unicli docker-hub info<br>unicli docker-hub search<br>unicli docker-hub tags |
| doctl | bridge | 1 | 0 | no | unicli doctl droplets |
| douban | web-api | 12 | 1 | yes | unicli douban marks<br>unicli douban book-hot<br>unicli douban download |
| doubao | web-api | 9 | 1 | yes | unicli doubao history<br>unicli doubao ask<br>unicli doubao new |
| doubao-web | web-api | 9 | 1 | yes | unicli doubao-web history<br>unicli doubao-web ask<br>unicli doubao-web detail |
| douyu | web-api | 2 | 0 | yes | unicli douyu hot<br>unicli douyu search |
| dpma | web-api | 2 | 0 | no | unicli dpma get<br>unicli dpma search |
| drawio | desktop | 1 | 0 | no | unicli drawio export |
| duckduckgo | web-api | 2 | 0 | no | unicli duckduckgo search<br>unicli duckduckgo suggest |
| eastmoney | web-api | 18 | 0 | no | unicli eastmoney fund<br>unicli eastmoney hot<br>unicli eastmoney market |
| ele | web-api | 2 | 0 | yes | unicli ele hot<br>unicli ele search |
| epo | web-api | 4 | 0 | no | unicli epo family<br>unicli epo get<br>unicli epo legal-status |
| excel | desktop | 7 | 0 | no | unicli excel insert-image<br>unicli excel insert-link<br>unicli excel list |
| exchangerate | web-api | 2 | 0 | no | unicli exchangerate convert<br>unicli exchangerate list |
| facebook | web-api | 15 | 3 | yes | unicli facebook feed<br>unicli facebook friends<br>unicli facebook notifications |
| feishu | bridge | 4 | 0 | yes | unicli feishu calendar<br>unicli feishu docs<br>unicli feishu send |
| ffmpeg | desktop | 11 | 0 | no | unicli ffmpeg compress<br>unicli ffmpeg concat<br>unicli ffmpeg convert |
| figma | browser | 8 | 0 | yes | unicli figma export-selected<br>unicli figma open-app<br>unicli figma status-app |
| flyctl | bridge | 1 | 0 | no | unicli flyctl apps |
| freecad | desktop | 15 | 0 | no | unicli freecad assembly<br>unicli freecad bom<br>unicli freecad boolean |
| futu | web-api | 2 | 0 | yes | unicli futu hot<br>unicli futu quote |
| gemini | web-api | 5 | 0 | yes | unicli gemini ask<br>unicli gemini deep-research-result<br>unicli gemini deep-research |
| gh | bridge | 16 | 0 | yes | unicli gh discussions<br>unicli gh file<br>unicli gh issue-thread |
| gimp | desktop | 12 | 0 | no | unicli gimp adjust<br>unicli gimp batch<br>unicli gimp convert |
| gitee | web-api | 4 | 0 | no | unicli gitee repos<br>unicli gitee search<br>unicli gitee trending |
| github-trending | web-api | 3 | 0 | no | unicli github-trending daily<br>unicli github-trending developers<br>unicli github-trending weekly |
| gitlab | web-api | 3 | 0 | no | unicli gitlab projects<br>unicli gitlab search<br>unicli gitlab trending |
| godot | desktop | 2 | 0 | no | unicli godot project-run<br>unicli godot scene-export |
| google | web-api | 4 | 0 | no | unicli google news<br>unicli google search<br>unicli google suggest |
| google-patents-bq | web-api | 2 | 0 | yes | unicli google-patents-bq prior-art<br>unicli google-patents-bq search |
| grok | web-api | 8 | 1 | yes | unicli grok history<br>unicli grok ask<br>unicli grok read |
| hackernews | web-api | 11 | 0 | no | unicli hackernews ask<br>unicli hackernews best<br>unicli hackernews comments |
| hermes | desktop | 3 | 0 | no | unicli hermes sessions-search<br>unicli hermes skills-list<br>unicli hermes skills-read |
| hf | web-api | 6 | 0 | no | unicli hf datasets<br>unicli hf models<br>unicli hf spaces |
| homebrew | web-api | 5 | 0 | no | unicli homebrew info<br>unicli homebrew search<br>unicli homebrew formula |
| huggingface-papers | web-api | 2 | 0 | no | unicli huggingface-papers daily<br>unicli huggingface-papers search |
| hupu | web-api | 7 | 1 | yes | unicli hupu mentions<br>unicli hupu detail<br>unicli hupu hot |
| imagemagick | desktop | 6 | 0 | no | unicli imagemagick compare<br>unicli imagemagick composite<br>unicli imagemagick convert |
| imdb | web-api | 7 | 0 | no | unicli imdb box-office<br>unicli imdb person<br>unicli imdb reviews |
| imessage | desktop | 3 | 0 | no | unicli imessage contact<br>unicli imessage recent<br>unicli imessage search |
| infoq | web-api | 2 | 0 | no | unicli infoq articles<br>unicli infoq latest |
| inkscape | desktop | 3 | 0 | no | unicli inkscape convert<br>unicli inkscape export<br>unicli inkscape optimize |
| inpi-fr | web-api | 2 | 0 | no | unicli inpi-fr get<br>unicli inpi-fr search |
| instagram | web-api | 29 | 4 | yes | unicli instagram activity<br>unicli instagram following<br>unicli instagram saved |
| ip-info | web-api | 1 | 0 | no | unicli ip-info lookup |
| ipaustralia | web-api | 2 | 0 | no | unicli ipaustralia get<br>unicli ipaustralia search |
| itch-io | web-api | 3 | 0 | no | unicli itch-io popular<br>unicli itch-io search<br>unicli itch-io top |
| ithome | web-api | 3 | 0 | no | unicli ithome hot<br>unicli ithome latest<br>unicli ithome news |
| jd | web-api | 7 | 0 | yes | unicli jd hot<br>unicli jd item<br>unicli jd search |
| jianyu | browser | 2 | 0 | yes | unicli jianyu search<br>unicli jianyu detail |
| jike | browser | 10 | 2 | yes | unicli jike feed<br>unicli jike notifications<br>unicli jike post |
| jimeng | web-api | 4 | 1 | yes | unicli jimeng history<br>unicli jimeng generate<br>unicli jimeng new |
| jina | web-api | 1 | 0 | no | unicli jina read |
| jpo | web-api | 2 | 0 | no | unicli jpo get<br>unicli jpo search |
| jq | bridge | 2 | 0 | no | unicli jq format<br>unicli jq query |
| juejin | web-api | 2 | 0 | no | unicli juejin hot<br>unicli juejin search |
| kdenlive | desktop | 3 | 0 | no | unicli kdenlive effects<br>unicli kdenlive info<br>unicli kdenlive render |
| ke | browser | 4 | 0 | yes | unicli ke ershoufang<br>unicli ke xiaoqu<br>unicli ke zufang |
| kipris | web-api | 3 | 0 | no | unicli kipris get<br>unicli kipris legal-status<br>unicli kipris search |
| konachan | web-api | 4 | 0 | no | unicli konachan detail<br>unicli konachan download<br>unicli konachan search |
| krita | desktop | 4 | 0 | no | unicli krita batch<br>unicli krita convert<br>unicli krita export |
| kuaishou | web-api | 2 | 0 | yes | unicli kuaishou hot<br>unicli kuaishou search |
| lark | bridge | 13 | 0 | yes | unicli lark native-agenda<br>unicli lark native-doc-fetch<br>unicli lark native-message-search |
| leetcode | web-api | 1 | 0 | no | unicli leetcode discuss-search |
| lens | web-api | 2 | 0 | yes | unicli lens get<br>unicli lens search |
| lesswrong | web-api | 15 | 0 | no | unicli lesswrong comments<br>unicli lesswrong curated<br>unicli lesswrong frontpage |
| libreoffice | desktop | 2 | 0 | no | unicli libreoffice convert<br>unicli libreoffice print |
| linear | web-api | 10 | 0 | yes | unicli linear issue-create<br>unicli linear issue-list<br>unicli linear issue-update |
| linkedin | web-api | 4 | 1 | yes | unicli linkedin timeline<br>unicli linkedin jobs<br>unicli linkedin profile |
| lobsters | web-api | 7 | 0 | no | unicli lobsters active<br>unicli lobsters hot<br>unicli lobsters newest |
| macos | desktop | 60 | 0 | no | unicli macos active-app<br>unicli macos apps-list<br>unicli macos apps |
| maimai | browser | 2 | 0 | yes | unicli maimai search<br>unicli maimai search-talents |
| maoyan | web-api | 2 | 0 | yes | unicli maoyan hot<br>unicli maoyan search |
| markdown-new | web-api | 1 | 0 | no | unicli markdown-new read |
| mastodon | web-api | 5 | 0 | no | unicli mastodon search<br>unicli mastodon timeline<br>unicli mastodon trending |
| maven | web-api | 3 | 0 | no | unicli maven info<br>unicli maven search<br>unicli maven artifact |
| medium | web-api | 6 | 0 | no | unicli medium article<br>unicli medium feed<br>unicli medium search |
| meituan | web-api | 1 | 0 | yes | unicli meituan search |
| mermaid | desktop | 1 | 0 | no | unicli mermaid render |
| minimax | web-api | 3 | 0 | yes | unicli minimax chat<br>unicli minimax models<br>unicli minimax tts |
| modelscope | web-api | 2 | 0 | no | unicli modelscope datasets<br>unicli modelscope models |
| motion-studio | web-api | 1 | 0 | no | unicli motion-studio component-get |
| mubu | web-api | 6 | 0 | yes | unicli mubu list<br>unicli mubu search<br>unicli mubu docs |
| musescore | desktop | 5 | 0 | no | unicli musescore convert<br>unicli musescore export<br>unicli musescore info |
| neonctl | bridge | 1 | 0 | no | unicli neonctl projects |
| netease-music | web-api | 17 | 0 | no | unicli netease-music hot<br>unicli netease-music playlist<br>unicli netease-music search |
| netlify | bridge | 1 | 0 | no | unicli netlify sites |
| notebooklm | web-api | 15 | 1 | yes | unicli notebooklm history<br>unicli notebooklm current<br>unicli notebooklm get |
| notion | web-api | 3 | 0 | yes | unicli notion databases<br>unicli notion pages<br>unicli notion search |
| novita | service | 3 | 0 | no | unicli novita generate<br>unicli novita models<br>unicli novita status |
| npm | web-api | 5 | 0 | no | unicli npm downloads<br>unicli npm info<br>unicli npm search |
| npm-trends | web-api | 2 | 0 | no | unicli npm-trends compare<br>unicli npm-trends trending |
| nuget | web-api | 3 | 0 | no | unicli nuget info<br>unicli nuget search<br>unicli nuget package |
| nytimes | web-api | 2 | 0 | no | unicli nytimes search<br>unicli nytimes top |
| obs | service | 8 | 0 | no | unicli obs record-start<br>unicli obs record-stop<br>unicli obs scenes |
| obsidian | desktop | 10 | 0 | no | unicli obsidian daily<br>unicli obsidian open<br>unicli obsidian search |
| ollama | service | 4 | 0 | no | unicli ollama generate<br>unicli ollama list<br>unicli ollama models |
| ollama-cloud | web-api | 2 | 0 | no | unicli ollama-cloud fetch<br>unicli ollama-cloud search |
| ones | web-api | 11 | 1 | yes | unicli ones me<br>unicli ones enrich-tasks<br>unicli ones login |
| opencode | bridge | 1 | 0 | no | unicli opencode version |
| opencsg | web-api | 2 | 0 | no | unicli opencsg datasets<br>unicli opencsg models |
| openharness | desktop | 2 | 0 | no | unicli openharness memory-read<br>unicli openharness skills-list |
| openrouter | web-api | 2 | 0 | no | unicli openrouter models<br>unicli openrouter search |
| packagist | web-api | 3 | 0 | no | unicli packagist info<br>unicli packagist search<br>unicli packagist package |
| pandoc | desktop | 1 | 0 | no | unicli pandoc convert |
| paperreview | web-api | 3 | 0 | no | unicli paperreview feedback<br>unicli paperreview review<br>unicli paperreview submit |
| patsnap | web-api | 2 | 0 | yes | unicli patsnap get<br>unicli patsnap search |
| pdf | desktop | 1 | 0 | no | unicli pdf read |
| perplexity | web-api | 8 | 0 | yes | unicli perplexity ask<br>unicli perplexity open-app<br>unicli perplexity status-app |
| pexels | web-api | 2 | 0 | yes | unicli pexels curated<br>unicli pexels search |
| pinduoduo | web-api | 2 | 0 | yes | unicli pinduoduo hot<br>unicli pinduoduo search |
| pixiv | web-api | 6 | 0 | yes | unicli pixiv detail<br>unicli pixiv download<br>unicli pixiv illusts |
| powerpoint | desktop | 7 | 0 | no | unicli powerpoint add-slide<br>unicli powerpoint insert-image<br>unicli powerpoint insert-link |
| pqai | web-api | 2 | 0 | no | unicli pqai prior-art<br>unicli pqai search |
| producthunt | web-api | 5 | 0 | no | unicli producthunt browse<br>unicli producthunt hot<br>unicli producthunt posts |
| pscale | bridge | 1 | 0 | no | unicli pscale databases |
| pub-dev | web-api | 2 | 0 | no | unicli pub-dev info<br>unicli pub-dev search |
| pypi | web-api | 5 | 0 | no | unicli pypi info<br>unicli pypi search<br>unicli pypi versions |
| quark | web-api | 8 | 0 | yes | unicli quark ls<br>unicli quark search<br>unicli quark mkdir |
| qweather | web-api | 2 | 0 | no | unicli qweather forecast<br>unicli qweather now |
| railway | bridge | 1 | 0 | no | unicli railway deploy |
| reddit | web-api | 24 | 5 | yes | unicli reddit saved<br>unicli reddit upvoted<br>unicli reddit whoami |
| renderdoc | desktop | 2 | 0 | no | unicli renderdoc capture-list<br>unicli renderdoc frame-export |
| replicate | web-api | 3 | 0 | yes | unicli replicate run<br>unicli replicate search<br>unicli replicate trending |
| reuters | web-api | 5 | 0 | no | unicli reuters article<br>unicli reuters latest<br>unicli reuters search |
| rubygems | web-api | 3 | 0 | no | unicli rubygems info<br>unicli rubygems search<br>unicli rubygems gem |
| safebooru | web-api | 4 | 0 | no | unicli safebooru detail<br>unicli safebooru download<br>unicli safebooru search |
| shotcut | desktop | 3 | 0 | no | unicli shotcut effects<br>unicli shotcut info<br>unicli shotcut render |
| sinablog | browser | 4 | 0 | no | unicli sinablog article<br>unicli sinablog hot<br>unicli sinablog search |
| sinafinance | web-api | 5 | 0 | no | unicli sinafinance market<br>unicli sinafinance news<br>unicli sinafinance rolling-news |
| sketch | desktop | 3 | 0 | no | unicli sketch artboards<br>unicli sketch export<br>unicli sketch symbols |
| slack | web-api | 14 | 1 | yes | unicli slack messages<br>unicli slack channels<br>unicli slack post |
| slay-the-spire-ii | service | 6 | 0 | no | unicli slay-the-spire-ii deck<br>unicli slay-the-spire-ii end-turn<br>unicli slay-the-spire-ii map |
| slock | browser | 1 | 0 | yes | unicli slock servers |
| smzdm | web-api | 3 | 0 | yes | unicli smzdm article<br>unicli smzdm hot<br>unicli smzdm search |
| spotify | web-api | 24 | 1 | yes | unicli spotify playlists<br>unicli spotify now-playing<br>unicli spotify search |
| sspai | web-api | 2 | 0 | no | unicli sspai hot<br>unicli sspai latest |
| stackoverflow | web-api | 10 | 0 | no | unicli stackoverflow bounties<br>unicli stackoverflow hot<br>unicli stackoverflow question |
| stagehand | bridge | 1 | 0 | no | unicli stagehand wrap-observe |
| steam | web-api | 7 | 0 | no | unicli steam app-details<br>unicli steam new-releases<br>unicli steam search |
| substack | web-api | 4 | 0 | no | unicli substack feed<br>unicli substack publication<br>unicli substack search |
| supabase | bridge | 1 | 0 | no | unicli supabase projects |
| taobao | browser | 6 | 0 | yes | unicli taobao hot<br>unicli taobao search<br>unicli taobao detail |
| techcrunch | web-api | 2 | 0 | no | unicli techcrunch latest<br>unicli techcrunch search |
| theverge | web-api | 2 | 0 | no | unicli theverge latest<br>unicli theverge search |
| threads | web-api | 6 | 0 | yes | unicli threads hot<br>unicli threads search<br>unicli threads user |
| tieba | web-api | 4 | 0 | no | unicli tieba hot<br>unicli tieba posts<br>unicli tieba read |
| tiktok | web-api | 18 | 3 | yes | unicli tiktok following<br>unicli tiktok friends<br>unicli tiktok notifications |
| toutiao | web-api | 3 | 0 | yes | unicli toutiao hot<br>unicli toutiao search<br>unicli toutiao articles |
| twitch | web-api | 4 | 0 | yes | unicli twitch games<br>unicli twitch search<br>unicli twitch streams |
| twitter | bridge | 52 | 9 | yes | unicli twitter mentions<br>unicli twitter native-me<br>unicli twitter bookmark-folders |
| ukipo | web-api | 1 | 0 | no | unicli ukipo info |
| unsplash | web-api | 2 | 0 | no | unicli unsplash random<br>unicli unsplash search |
| uspto | web-api | 3 | 0 | no | unicli uspto get<br>unicli uspto legal-status<br>unicli uspto search |
| v2ex | web-api | 12 | 2 | yes | unicli v2ex me<br>unicli v2ex notifications<br>unicli v2ex daily |
| vercel | bridge | 1 | 0 | no | unicli vercel list |
| vscode | desktop | 10 | 0 | no | unicli vscode extensions<br>unicli vscode install-ext<br>unicli vscode open |
| web | web-api | 1 | 0 | no | unicli web read |
| wechat-channels | web-api | 2 | 0 | yes | unicli wechat-channels hot<br>unicli wechat-channels search |
| weibo | web-api | 12 | 4 | yes | unicli weibo feed<br>unicli weibo me<br>unicli weibo timeline |
| weixin | browser | 6 | 0 | yes | unicli weixin article<br>unicli weixin download<br>unicli weixin hot |
| weread | web-api | 8 | 2 | yes | unicli weread notebooks<br>unicli weread shelf<br>unicli weread book |
| wikipedia | web-api | 6 | 0 | no | unicli wikipedia random<br>unicli wikipedia search<br>unicli wikipedia summary |
| wipo-patentscope | web-api | 1 | 0 | no | unicli wipo-patentscope info |
| wiremock | service | 5 | 0 | no | unicli wiremock create-stub<br>unicli wiremock delete-stub<br>unicli wiremock reset |
| word | desktop | 7 | 0 | no | unicli word insert-image<br>unicli word insert-link<br>unicli word insert-text |
| wrangler | bridge | 1 | 0 | no | unicli wrangler list |
| xianyu | web-api | 4 | 0 | yes | unicli xianyu chat<br>unicli xianyu item<br>unicli xianyu search |
| xiaoe | web-api | 5 | 0 | yes | unicli xiaoe catalog<br>unicli xiaoe content<br>unicli xiaoe courses |
| xiaohongshu | web-api | 23 | 3 | yes | unicli xiaohongshu notifications<br>unicli xiaohongshu feed<br>unicli xiaohongshu saved |
| xiaoyuzhou | web-api | 5 | 0 | yes | unicli xiaoyuzhou episode<br>unicli xiaoyuzhou podcast-episodes<br>unicli xiaoyuzhou podcast |
| xueqiu | web-api | 14 | 1 | yes | unicli xueqiu feed<br>unicli xueqiu comments<br>unicli xueqiu earnings-date |
| yahoo | web-api | 1 | 0 | no | unicli yahoo search |
| yahoo-finance | web-api | 3 | 0 | no | unicli yahoo-finance quote<br>unicli yahoo-finance search<br>unicli yahoo-finance trending |
| yandere | web-api | 4 | 0 | no | unicli yandere detail<br>unicli yandere download<br>unicli yandere search |
| ycombinator | web-api | 1 | 0 | no | unicli ycombinator launches |
| yollomi | web-api | 12 | 0 | yes | unicli yollomi background<br>unicli yollomi edit<br>unicli yollomi face-swap |
| youtube | web-api | 17 | 4 | yes | unicli youtube feed<br>unicli youtube history<br>unicli youtube watch-later |
| yt-dlp | bridge | 5 | 0 | no | unicli yt-dlp download<br>unicli yt-dlp extract-audio<br>unicli yt-dlp info |
| yuanbao | web-api | 8 | 1 | yes | unicli yuanbao history<br>unicli yuanbao ask<br>unicli yuanbao new |
| zhihu | web-api | 37 | 11 | yes | unicli zhihu collections<br>unicli zhihu feed<br>unicli zhihu following |
| zoom | desktop | 3 | 0 | no | unicli zoom join<br>unicli zoom start<br>unicli zoom toggle-mute |
| zotero | service | 8 | 0 | no | unicli zotero add-note<br>unicli zotero add-tag<br>unicli zotero collections |
| zsxq | web-api | 5 | 0 | yes | unicli zsxq dynamics<br>unicli zsxq groups<br>unicli zsxq search |
| 1point3acres | web-api | 9 | 1 | yes | unicli 1point3acres notifications<br>unicli 1point3acres hot<br>unicli 1point3acres latest |
| 51job | web-api | 4 | 0 | yes | unicli 51job search<br>unicli 51job hot<br>unicli 51job detail |
| aaai | web-api | 3 | 0 | no | unicli aaai papers<br>unicli aaai search<br>unicli aaai paper |
| acl-anthology | web-api | 3 | 0 | no | unicli acl-anthology search<br>unicli acl-anthology paper<br>unicli acl-anthology read |
| acm | web-api | 3 | 0 | no | unicli acm search<br>unicli acm venue<br>unicli acm paper |
| ai | web-api | 6 | 0 | no | unicli ai search<br>unicli ai pulse<br>unicli ai read |
| aibase | web-api | 1 | 0 | no | unicli aibase news |
| anilist | web-api | 5 | 0 | no | unicli anilist anime<br>unicli anilist manga<br>unicli anilist characters |
| antigravity | web-api | 17 | 0 | no | unicli antigravity ask<br>unicli antigravity send<br>unicli antigravity read |
| archive | web-api | 4 | 0 | no | unicli archive item<br>unicli archive search<br>unicli archive snapshots |
| baidu-scholar | web-api | 1 | 0 | no | unicli baidu-scholar search |
| bangumi | web-api | 5 | 0 | no | unicli bangumi anime<br>unicli bangumi book<br>unicli bangumi game |
| biorxiv | web-api | 5 | 0 | no | unicli biorxiv recent<br>unicli biorxiv search<br>unicli biorxiv paper |
| ccf | web-api | 2 | 0 | no | unicli ccf conferences<br>unicli ccf conference |
| chatgpt | web-api | 18 | 1 | yes | unicli chatgpt history<br>unicli chatgpt ask<br>unicli chatgpt send |
| chatgpt-app | web-api | 8 | 0 | no | unicli chatgpt-app ask<br>unicli chatgpt-app send<br>unicli chatgpt-app read |
| chatwise | web-api | 17 | 0 | no | unicli chatwise ask<br>unicli chatwise send<br>unicli chatwise read |
| cipo | web-api | 3 | 0 | no | unicli cipo get<br>unicli cipo legal-status<br>unicli cipo search |
| claude | web-api | 14 | 1 | yes | unicli claude history<br>unicli claude ask<br>unicli claude send |
| cnipa | web-api | 3 | 0 | no | unicli cnipa get<br>unicli cnipa legal-status<br>unicli cnipa search |
| cnki | web-api | 1 | 0 | no | unicli cnki search |
| codex | web-api | 19 | 0 | no | unicli codex ask<br>unicli codex send<br>unicli codex read |
| coingecko | web-api | 7 | 0 | no | unicli coingecko coin<br>unicli coingecko top<br>unicli coingecko trending |
| crates | web-api | 2 | 0 | no | unicli crates search<br>unicli crates crate |
| crossref | web-api | 3 | 0 | no | unicli crossref search<br>unicli crossref work<br>unicli crossref venue |
| ctrip | web-api | 4 | 0 | yes | unicli ctrip search<br>unicli ctrip hotel-suggest<br>unicli ctrip hotel-search |
| cursor | web-api | 19 | 0 | no | unicli cursor ask<br>unicli cursor send<br>unicli cursor read |
| cvf | web-api | 3 | 0 | no | unicli cvf search<br>unicli cvf paper<br>unicli cvf read |
| datacite | web-api | 3 | 0 | no | unicli datacite search<br>unicli datacite doi<br>unicli datacite related |
| dblp | web-api | 4 | 0 | no | unicli dblp search<br>unicli dblp paper<br>unicli dblp venue |
| defillama | web-api | 2 | 0 | no | unicli defillama protocols<br>unicli defillama protocol |
| discord-app | web-api | 15 | 0 | no | unicli discord-app servers<br>unicli discord-app channels<br>unicli discord-app read |
| dlsite | web-api | 8 | 0 | no | unicli dlsite search<br>unicli dlsite manga<br>unicli dlsite cg |
| dockerhub | web-api | 2 | 0 | no | unicli dockerhub search<br>unicli dockerhub image |
| doubao-app | web-api | 14 | 0 | no | unicli doubao-app ask<br>unicli doubao-app send<br>unicli doubao-app read |
| douyin | web-api | 13 | 1 | yes | unicli douyin collections<br>unicli douyin activities<br>unicli douyin delete |
| ehentai | web-api | 6 | 0 | no | unicli ehentai search<br>unicli ehentai artist<br>unicli ehentai tag |
| notion-app | web-api | 16 | 0 | no | unicli notion-app open-app<br>unicli notion-app status-app<br>unicli notion-app dump |
| logseq | web-api | 7 | 0 | no | unicli logseq open-app<br>unicli logseq status-app<br>unicli logseq dump |
| typora | web-api | 7 | 0 | no | unicli typora open-app<br>unicli typora status-app<br>unicli typora dump |
| postman | web-api | 7 | 0 | no | unicli postman open-app<br>unicli postman status-app<br>unicli postman dump |
| insomnia | web-api | 7 | 0 | no | unicli insomnia open-app<br>unicli insomnia status-app<br>unicli insomnia dump |
| bitwarden | web-api | 7 | 0 | no | unicli bitwarden open-app<br>unicli bitwarden status-app<br>unicli bitwarden dump |
| signal | web-api | 7 | 0 | no | unicli signal open-app<br>unicli signal status-app<br>unicli signal dump |
| whatsapp | web-api | 7 | 0 | no | unicli whatsapp open-app<br>unicli whatsapp status-app<br>unicli whatsapp dump |
| teams | web-api | 7 | 0 | no | unicli teams open-app<br>unicli teams status-app<br>unicli teams dump |
| todoist | web-api | 7 | 0 | no | unicli todoist open-app<br>unicli todoist status-app<br>unicli todoist dump |
| github-desktop | web-api | 7 | 0 | no | unicli github-desktop open-app<br>unicli github-desktop status-app<br>unicli github-desktop dump |
| gitkraken | web-api | 7 | 0 | no | unicli gitkraken open-app<br>unicli gitkraken status-app<br>unicli gitkraken dump |
| docker-desktop | web-api | 7 | 0 | no | unicli docker-desktop open-app<br>unicli docker-desktop status-app<br>unicli docker-desktop dump |
| lm-studio | web-api | 7 | 0 | no | unicli lm-studio open-app<br>unicli lm-studio status-app<br>unicli lm-studio dump |
| wechat-work | web-api | 7 | 0 | no | unicli wechat-work open-app<br>unicli wechat-work status-app<br>unicli wechat-work dump |
| zoom-app | web-api | 7 | 0 | no | unicli zoom-app open-app<br>unicli zoom-app status-app<br>unicli zoom-app dump |
| evernote-app | web-api | 7 | 0 | no | unicli evernote-app open-app<br>unicli evernote-app status-app<br>unicli evernote-app dump |
| endoflife | web-api | 1 | 0 | no | unicli endoflife product |
| espacenet | web-api | 4 | 0 | no | unicli espacenet family<br>unicli espacenet get<br>unicli espacenet legal-status |
| fips | web-api | 2 | 0 | no | unicli fips get<br>unicli fips search |
| flathub | web-api | 2 | 0 | no | unicli flathub search<br>unicli flathub app |
| freepatentsonline-web | web-api | 2 | 0 | no | unicli freepatentsonline-web get<br>unicli freepatentsonline-web search |
| github-scholar | web-api | 1 | 0 | no | unicli github-scholar search |
| google-patents-web | web-api | 2 | 0 | no | unicli google-patents-web get<br>unicli google-patents-web search |
| google-scholar | web-api | 3 | 0 | no | unicli google-scholar cite<br>unicli google-scholar profile<br>unicli google-scholar search |
| goproxy | web-api | 2 | 0 | no | unicli goproxy module<br>unicli goproxy versions |
| gov-law | web-api | 2 | 0 | no | unicli gov-law search<br>unicli gov-law recent |
| gov-policy | web-api | 2 | 0 | no | unicli gov-policy search<br>unicli gov-policy recent |
| iclr | web-api | 1 | 0 | no | unicli iclr awards |
| ieee | web-api | 3 | 0 | no | unicli ieee search<br>unicli ieee venue<br>unicli ieee paper |
| ieee-xplore | web-api | 3 | 0 | no | unicli ieee-xplore search<br>unicli ieee-xplore article<br>unicli ieee-xplore venue |
| indeed | web-api | 2 | 0 | yes | unicli indeed search<br>unicli indeed job |
| inpi-br | web-api | 2 | 0 | no | unicli inpi-br get<br>unicli inpi-br search |
| jikan | web-api | 4 | 0 | no | unicli jikan anime<br>unicli jikan manga<br>unicli jikan characters |
| kitsu | web-api | 2 | 0 | no | unicli kitsu anime<br>unicli kitsu manga |
| lichess | web-api | 2 | 0 | no | unicli lichess top<br>unicli lichess user |
| linux-do | browser | 11 | 1 | yes | unicli linux-do feed<br>unicli linux-do categories<br>unicli linux-do category |
| mangadex | web-api | 2 | 0 | no | unicli mangadex manga<br>unicli mangadex authors |
| marxists-cn | web-api | 7 | 0 | no | unicli marxists-cn index<br>unicli marxists-cn reading-list<br>unicli marxists-cn western-marxism |
| mdn | web-api | 1 | 0 | no | unicli mdn search |
| medrxiv | web-api | 5 | 0 | no | unicli medrxiv recent<br>unicli medrxiv search<br>unicli medrxiv paper |
| moegirl | web-api | 3 | 0 | no | unicli moegirl search<br>unicli moegirl page<br>unicli moegirl links |
| neurips | web-api | 3 | 0 | no | unicli neurips search<br>unicli neurips paper<br>unicli neurips read |
| nowcoder | web-api | 16 | 1 | yes | unicli nowcoder notifications<br>unicli nowcoder hot<br>unicli nowcoder trending |
| nvd | web-api | 1 | 0 | no | unicli nvd cve |
| oeis | web-api | 2 | 0 | no | unicli oeis search<br>unicli oeis sequence |
| openalex | web-api | 3 | 0 | no | unicli openalex search<br>unicli openalex work<br>unicli openalex read |
| openfda | web-api | 2 | 0 | no | unicli openfda drug-label<br>unicli openfda food-recall |
| openreview | web-api | 8 | 0 | yes | unicli openreview conference<br>unicli openreview search<br>unicli openreview paper |
| osv | web-api | 2 | 0 | no | unicli osv query<br>unicli osv vulnerability |
| pacmpl | web-api | 3 | 0 | no | unicli pacmpl search<br>unicli pacmpl venue<br>unicli pacmpl paper |
| pmlr | web-api | 3 | 0 | no | unicli pmlr search<br>unicli pmlr paper<br>unicli pmlr read |
| powerchina | web-api | 1 | 0 | yes | unicli powerchina search |
| pubmed | web-api | 7 | 0 | no | unicli pubmed search<br>unicli pubmed article<br>unicli pubmed paper |
| qwen | web-api | 8 | 1 | yes | unicli qwen history<br>unicli qwen ask<br>unicli qwen read |
| rednote | web-api | 7 | 2 | yes | unicli rednote feed<br>unicli rednote notifications<br>unicli rednote note |
| rest-countries | web-api | 2 | 0 | no | unicli rest-countries country<br>unicli rest-countries region |
| retrieval | web-api | 2 | 0 | no | unicli retrieval search<br>unicli retrieval sources |
| rfc | web-api | 1 | 0 | no | unicli rfc rfc |
| scholar-artifacts | web-api | 2 | 0 | no | unicli scholar-artifacts download-pdf<br>unicli scholar-artifacts read-pdf |
| semantic-scholar | web-api | 6 | 0 | no | unicli semantic-scholar search<br>unicli semantic-scholar paper<br>unicli semantic-scholar read |
| sigchi | web-api | 3 | 0 | no | unicli sigchi conferences<br>unicli sigchi papers<br>unicli sigchi awards |
| tdx | web-api | 1 | 0 | yes | unicli tdx hot-rank |
| ths | web-api | 1 | 0 | yes | unicli ths hot-rank |
| tvmaze | web-api | 2 | 0 | no | unicli tvmaze search<br>unicli tvmaze show |
| uisdc | web-api | 1 | 0 | no | unicli uisdc news |
| uiverse | web-api | 2 | 0 | no | unicli uiverse code<br>unicli uiverse preview |
| unpaywall | web-api | 2 | 0 | no | unicli unpaywall oa<br>unicli unpaywall read |
| usenix | web-api | 5 | 0 | no | unicli usenix conferences<br>unicli usenix venue<br>unicli usenix search |
| vndb | web-api | 7 | 0 | no | unicli vndb search<br>unicli vndb vn<br>unicli vndb releases |
| wanfang | web-api | 1 | 0 | no | unicli wanfang search |
| wikidata | web-api | 2 | 0 | no | unicli wikidata search<br>unicli wikidata entity |
| wttr | web-api | 2 | 0 | no | unicli wttr current<br>unicli wttr forecast |
| zlibrary | web-api | 2 | 0 | yes | unicli zlibrary search<br>unicli zlibrary info |
