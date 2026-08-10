<!-- 由 docs/zh/guide/scholarly-discovery.md 生成。不要直接编辑此副本。 -->

# 跨站追踪学术资源

- 规范页: https://olo-dot-io.github.io/Uni-CLI/zh/guide/scholarly-discovery
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/zh/guide/scholarly-discovery.md
- 栏目: 使用 Uni-CLI
- 上级: 使用 Uni-CLI (/zh/guide/)

Uni-CLI 把一篇论文看成一组可以互相连接的记录。DOI 可以连到出版元数据、官方会议程序、奖项标记、OpenReview 论坛、PDF、代码和研究数据。每条关系都保留自己的来源 URL。

## 从一条引用开始

输入 DOI、精确标题、arXiv 标识符、PMID 或 OpenReview 论坛 URL。

```bash
unicli scholar trace 10.1145/3772318.3791239 -D
unicli scholar trace "Attention Is All You Need" -D
```

`scholar trace` 先确定论文记录，再用确定后的标题搜索 OpenReview。能够识别会议时，它还会检查官方会议程序，并查询代码与数据集来源。资源记录保留来源、关系证据和候选状态。

显式传入的会议与年份会先约束论文记录，再参与关系连接。论文记录已经带有 OpenReview forum 标识符时，trace 会直接复用它读取 review 与 rebuttal。按标题寻找资源时，命令只连接论文标题精确一致的记录，避免相近论文的代码仓库混入结果。

出版元数据使用完整 proceedings 名称时，可以直接指定会议。

```bash
unicli scholar trace 10.1145/3772318.3791239 \
  --venue CHI \
  --year 2026 \
  -D
```

## 查询当前 CCF A 类目录

内置 CCF 目录以 2026 年发布并在 4 月 9 日勘误的第七版正式 PDF 为准。目录覆盖十个领域的 58 个 A 类会议。每条记录保留 PDF 页码、来源 URL、会议链接、出版方、旧名和别名。

```bash
unicli ccf conferences
unicli ccf conferences --category "网络与信息安全"
unicli ccf conference ICLR
unicli ccf conference "USENIX ATC"
```

旧名 `USENIX ATC` 会解析到 `ACM SIGOPS ATC`。第七版正式目录已经移除 `IJCAI`，查询它会返回结构化 `empty_result`。

## 按会议和年份检索

`scholar venue` 用于跨来源检索 proceedings。命令会先解析 CCF 缩写和旧名，再选择可用来源。ACM 与 IEEE 都会进入候选来源，因为 DOI 注册方可能随年份变化，也可能与目录中的出版方标签不同。精确会议和年份检查会剔除相近缩写以及其他年份的记录。位置参数已经包含年份时，例如 `PPoPP 2025`，可以省略 `--year`。

```bash
unicli scholar venue FAST --year 2025
unicli scholar venue FOCS --year 2024
unicli scholar venue CAV --year 2024
unicli scholar venue FM --year 2024
unicli scholar search "program synthesis" --venue PLDI --year 2025
```

DBLP 为缺少适用论文接口的 CCF 会议提供 proceedings，其中包括 Springer 出版的 CAV 与 FM。卷册在次年出版时，Uni-CLI 会把会议年份写入 `year`，并把出版年份保留在 `publication_year`。

FAST、NSDI、OSDI、USENIX Security 和旧名 USENIX ATC 已接入 USENIX 官方来源。适配器读取官方 technical session 页面和 presentation 元数据。官方页面提供 `citation_pdf_url` 时，结果才包含 PDF。

```bash
unicli usenix venue FAST --year 2025
unicli usenix awards FAST --year 2025
unicli usenix paper "https://www.usenix.org/conference/fast25/presentation/liu-jing"
```

AAAI 主轨论文来自 AAAI 官方 proceedings 站点。OOPSLA、POPL、PLDI 和 ICFP 使用 PACMPL 会议视图，并保留卷号与 issue。OOPSLA 在 2021 年及以前使用旧 issue，从 2022 年起合并 OOPSLA1 与 OOPSLA2。FSE 2024 及后续年份通过 PACMSE 查询。SIGMOD 2023 及后续年份按照官方论文索引列出的 PACMMOD issue 查询，索引可以包含上一自然年发表的 issue。SIGGRAPH 通过 ACM Transactions on Graphics 的主会 issue 查询。VLDB 通过 Proceedings of the VLDB Endowment 查询。直接使用 `PACMPL`、`PACMSE`、`PACMMOD`、`PVLDB` 或 `VLDB` 可以列出对应期刊内容，同时避免误认成其他会议缩写。

```bash
unicli aaai papers --year 2025 --limit 20
unicli scholar venue AAAI --year 2025
unicli pacmpl venue OOPSLA --year 2024
unicli pacmpl venue OOPSLA2 --year 2024
unicli acm venue FSE --year 2024
unicli acm venue SIGMOD --year 2025
unicli acm venue SIGGRAPH --year 2024
unicli scholar venue PACMSE --year 2024
unicli scholar venue VLDB --year 2025
unicli scholar venue "PPoPP 2025"
```

`scholar search` 会从自由文本中提取可以确认的 CCF 会议和年份，随后剔除 proceedings 前置页，并对融合结果执行会议与年份检查。首次检索没有相关结果时，命令会执行一次受限的拼写恢复。字段 `query_corrections` 保存改正的词，`search_query` 保存实际执行的查询。

```bash
unicli scholar search "PPoPP 2025 parallel programming"
unicli scholar search "Budget Recyling Diferential Privcy" \
  --sources ieee,crossref \
  -D
```

搜索和会议查询默认给每个来源 20 秒。PDF、资源与可用性收集器会并发执行互相独立的来源。OpenReview 请求和重试等待会响应调用方取消，并受单次请求期限约束。网络较慢时，可以用 `--timeout` 调整 Scholar 命令的期限。

```bash
unicli scholar venue FAST --year 2025 --timeout 30
```

## 读取评审和作者回复

追踪结果用 `peer-review-thread` 标记 OpenReview 匹配项。字段 `next_command` 会带上论坛标识符。

```bash
unicli scholar reviews abcDEF123 -D
```

论坛公开相应内容时，评审读取器会按时间返回 review、作者回复、decision、meta-review 和公开评论。

## 查找官方奖项

SIGCHI 官方会议程序同时提供奖项标记、论文标识符和 ACM DOI。ICLR 官方公告会把获奖论文直接连接到 OpenReview 论坛、评审历史、作者回复和 PDF。

```bash
unicli scholar awards CHI --year 2026
unicli sigchi awards CHI --year 2026 --award best-paper
unicli sigchi papers UIST --year 2025 --query "interaction"
unicli scholar awards ICLR --year 2025
unicli iclr awards ICLR --year 2025 --award outstanding-paper
unicli scholar trace "https://openreview.net/forum?id=6Mxhg9PtDE" \
  --venue "ICLR 2025" \
  --year 2025 \
  -D
```

奖项记录保留官方程序或公告 URL。SIGCHI 记录可以通过 DOI 继续查找出版和研究资源。ICLR 记录可以通过论坛标识符读取 OpenReview 的 review、rebuttal、decision 和 PDF。

## 搜索 ACM 和 IEEE

ACM 与 IEEE 的 DOI 注册元数据支持免密钥检索。配置 API key 后，IEEE Xplore 还能返回 article number、访问状态、引用量、会议详情和出版商 PDF 链接。

```bash
unicli acm search "accessible interaction" --year 2026
unicli acm venue "CHI Conference" --year 2026
unicli ieee search "human robot interaction" --year 2025

export IEEE_XPLORE_API_KEY="..."
unicli ieee-xplore search "human robot interaction" --year 2025
```

`unicli ieee search` 无需密钥。`unicli ieee-xplore search` 使用 IEEE 官方 Metadata API。缺少密钥时，它会返回结构化 `config_error`。

## 查找数据和软件

DataCite 可以把论文 DOI 与注册数据集、软件连接起来。Hugging Face 和论文资源适配器继续补充模型、Space 与项目页。GitHub 学术适配器会在仓库元数据和 README 中查找 DOI 或高强度标题证据。

```bash
unicli datacite search "benchmark dataset" --type Dataset
unicli datacite related 10.1145/3772318.3791239
unicli scholar datasets 10.1145/3772318.3791239 -D
unicli scholar code 10.1145/3772318.3791239 -D
```

GitHub 搜索结果在取得更强的归属证据前保持候选状态。每条记录用 `relationship`、`verification`、`match_type` 和 `confidence` 说明匹配性质，并附上证据 URL 或片段。搜索得到的候选记录始终使用 `is_official_code=false`。`scholar trace` 会把这些代码和数据集关系与出版记录、评审、奖项及 PDF 一起返回，并保留各自来源。

```bash
unicli github-scholar search \
  --doi 10.1145/3718958.3754348 \
  --title "Raha" \
  --limit 10
```

## 连接规则

解析器依次使用 DOI、arXiv、PMID、OpenReview 和来源内标识符。缺少标识符时，它会在有限范围内比较规范化标题、年份和作者。每条关系保留 `source_adapter`、`source_url` 和 `retrieved_at`。

奖项结论需要官方会议或学会来源。评审结论需要评审平台线程。PDF 和开放获取结论需要可以独立检查的提供方 URL。

## 学术资源版图

已经接入的来源覆盖通用学术图谱、计算机会议、预印本、医学、中文文献检索、开放评审、开放获取、研究资源和本地文献库。运行 `unicli scholar coverage --sources all -D` 可以查看当前命令面。

下表中的后续来源已经纳入适配要求。一个新来源需要具备稳定来源身份、明确认证方式、规范化记录、可执行错误建议和真实查询验证，随后才进入发布目录。

| 资源族         | 已接入来源                                                                                                           | 后续适配要求                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| DOI 与引用图谱 | Crossref、DataCite、OpenAlex、Semantic Scholar、DBLP                                                                 | OpenAIRE Graph、CORE、Wikidata 学术记录、Lens、Dimensions、Scopus、Web of Science                                                  |
| 开放评审       | OpenReview                                                                                                           | 会议自建评审系统、期刊公开评审历史、评审附件、decision 修订记录                                                                    |
| 计算机会议     | AAAI、ACM、PACMPL、PACMSE、PACMMOD、SIGCHI、ICLR、IEEE、IEEE Xplore、USENIX、ACL Anthology、CVF、PMLR、NeurIPS、DBLP | JMLR、Dagstuhl、LIPIcs、CEUR-WS、Springer proceedings                                                                              |
| 预印本与机构库 | arXiv、bioRxiv、medRxiv                                                                                              | HAL、SSRN、OSF Preprints、ChemRxiv、Research Square、RePEc、EconPapers                                                             |
| 医学与生命科学 | PubMed、PMC 链接、bioRxiv、medRxiv                                                                                   | Europe PMC、ClinicalTrials.gov、WHO ICTRP、Cochrane、Crossmark 更正记录                                                            |
| 期刊与图书     | Crossref 出版元数据、Google Scholar、百度学术、CNKI、万方                                                            | DOAJ、JSTOR、Project MUSE、Open Library、HathiTrust、Springer Nature、Elsevier、Wiley、Taylor and Francis、Sage、Oxford、Cambridge |
| 作者与机构     | OpenAlex、Semantic Scholar、DBLP、OpenReview、PubMed 作者记录                                                        | ORCID、ROR、Wikidata、Open Funder Registry、各国研究者注册库                                                                       |
| 数据与软件     | DataCite、Hugging Face 资源、经过证据验证的 GitHub 候选                                                              | Zenodo、Figshare、Dryad、Dataverse、OSF、Software Heritage、GitLab、机构知识库                                                     |
| 学科索引       | PubMed、ACL、CVF、PMLR、NeurIPS                                                                                      | NASA ADS、INSPIRE、zbMATH Open、MathSciNet、ERIC、AGRICOLA、GeoRef、PhilPapers                                                     |
| 奖项与公告     | SIGCHI 与 USENIX 官方程序、ICLR 官方公告                                                                             | ACM 奖项页、IEEE 学会奖项、会议新闻页、学会订阅源、更正与撤稿公告                                                                  |
| 个人文献库     | Zotero                                                                                                               | BibTeX、CSL JSON、EndNote XML、RIS、本地 PDF 集合                                                                                  |

付费和机构授权来源保留明确边界。适配器需要说明 API key、订阅或浏览器会话要求。受限结果必须返回相应错误，不能伪装成空结果。

## 官方接口依据

适配器开发以提供方接口或官方公开资源为依据。

| 提供方            | 官方接口                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| Crossref          | [REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/)                 |
| DataCite          | [REST API](https://support.datacite.org/docs/api)                                              |
| OpenAlex          | [API 文档](https://docs.openalex.org/)                                                         |
| Semantic Scholar  | [Academic Graph API](https://www.semanticscholar.org/product/api)                              |
| IEEE Xplore       | [API 门户](https://developer.ieee.org/)                                                        |
| OpenReview        | [API 文档](https://docs.openreview.net/)                                                       |
| ICLR              | [官方博客 WordPress API](https://blog.iclr.cc/wp-json/wp/v2/posts)                             |
| CCF               | [推荐目录官网](https://www.ccf.org.cn/Academic_Evaluation/By_category/)                        |
| USENIX            | [官方会议 proceedings](https://www.usenix.org/conferences/byname/108)                          |
| AAAI              | [官方 proceedings](https://ojs.aaai.org/index.php/AAAI)                                        |
| PACMPL            | [Crossref 期刊记录](https://api.crossref.org/journals/2475-1421/works)                         |
| PACMSE            | [Crossref 期刊记录](https://api.crossref.org/journals/2994-970X/works)                         |
| PACMMOD           | [Crossref 期刊记录](https://api.crossref.org/journals/2836-6573/works)                         |
| ACM TOG           | [Crossref 期刊记录](https://api.crossref.org/journals/0730-0301/works)                         |
| SIGMOD            | [官方接收论文](https://2026.sigmod.org/sigmod_papers.shtml)                                    |
| GitHub            | [REST API](https://docs.github.com/en/rest)                                                    |
| Datamuse          | [Word-finding API](https://www.datamuse.com/api/)                                              |
| ACL Anthology     | [API 文档](https://aclanthology.org/info/api/)                                                 |
| DBLP              | [Search API 文档](https://dblp.org/faq/How+to+use+the+dblp+search+API.html)                    |
| OpenAIRE          | [Graph API](https://graph.openaire.eu/develop/api.html)                                        |
| CORE              | [API 文档](https://core.ac.uk/services/api)                                                    |
| Europe PMC        | [REST service](https://europepmc.org/RestfulWebService)                                        |
| ORCID             | [Public API 指南](https://info.orcid.org/documentation/integration-guide/orcid-api-tutorials/) |
| ROR               | [REST API](https://ror.readme.io/docs/rest-api)                                                |
| Software Heritage | [Web API](https://archive.softwareheritage.org/api/)                                           |

## 适配器能力

每个学术来源按实际能力提供下列接口的一部分。

| 能力                 | 返回证据                          |
| -------------------- | --------------------------------- |
| `scholar.search`     | 带来源身份的排序论文记录          |
| `scholar.get`        | 通过稳定标识符读取一条书目记录    |
| `scholar.pdf`        | 有来源依据的 PDF 候选             |
| `scholar.fulltext`   | 来源可读全文                      |
| `scholar.review`     | review、rebuttal、decision 和评论 |
| `scholar.venue`      | 会议 proceedings 或期刊内容       |
| `scholar.awards`     | 官方奖项记录                      |
| `scholar.context`    | 会议程序、公告、更正或其他上下文  |
| `scholar.citations`  | 引用当前论文的文献                |
| `scholar.references` | 当前论文引用的文献                |
| `scholar.code`       | 软件和项目链接                    |
| `scholar.datasets`   | 数据、模型和相关研究对象          |

选择来源前先运行 `unicli search "<academic intent>"`。需要检查实时状态时，运行 `unicli scholar doctor --sources all --live`。
