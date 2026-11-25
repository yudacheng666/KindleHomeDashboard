# 关键可行性证据（2026-11-25）
只记录仍影响选型和下一步的公开来源；下列第三方记录不代表本项目实际验收。真实部署配置不公开。

## 数据源（阻塞）
- 公交优先：政府公共数据开放平台 https://data.sh.gov.cn/ 。近期个人墨水屏开发案例 https://www.lab-z.com/bsshow/ 、https://www.eetree.cn/project/detail/5310 报告实名取得 Token；资源 sod-p4pm95e968tfxhil41cotzxyn，响应含线路/站点 ID 及上下行。案例展示的计划发车字段不能证明在途 ETA。平台网页访问返回412，未执行授权 POST；当前开放条件、免费额度、覆盖及真实多车 ETA 均未确认。
- 公交备选：随申行 https://open-web.shmaas.cn/docs/guide/ 及公共交通文档有 getBusStopArriveDetails（多车 ETA），需商务凭证及出口 IP，个人免费授权未知；不要求用户发邮件。Code410 https://www.code410.com/api/231 文档称免费，基础 URL 返回缺参数提示，示例查询未取得车辆数据，上游授权及额度未确认。其他低额度或未确认上游授权的逆向接口不作为正式依赖；不重复调查已失效的旧接口。
- 驾车：高德 https://lbs.amap.com/api/webservice/guide/api/newroute 、https://lbs.amap.com/pages/base_service_price 及百度 https://lbsyun.baidu.com/docs/webapi?title=directionv2%2Fdirection-api-v2 有正式算路能力，仍需合法 Key、个人免费权限、实时路况字段及实测。基础额度不等于高级路况免费。核实缓存许可；不开通收费服务。
- 天气：HA https://www.home-assistant.io/integrations/open_meteo/ 与 https://open-meteo.com/en/pricing （非商业免费至1万次/日，无可用性承诺）支持基础天气；实际网络、预警与空气质量覆盖待验证。

## HA 架构候选证据
- 原生 REST https://www.home-assistant.io/integrations/rest/ 、https://www.home-assistant.io/integrations/template/ 、https://www.home-assistant.io/integrations/workday/ ：GET/POST、周期及自动化查询、模板、工作日；需确认分时轮询、调休、错误及时间语义。高频实体历史可由 https://www.home-assistant.io/integrations/recorder/ 排除。
- 驾车参考 https://github.com/DavisDL-89/amap_commute ：作者文档有多路线、UI 配置、时间/距离/路况，后端需 Web 服务 Key；地图前端需额外 JS Key，墨水屏文字展示不必用地图卡。未审查完整代码、许可及稳定性。
- 家庭 https://www.home-assistant.io/integrations/local_todo/ 、https://www.home-assistant.io/integrations/shopping_list/ 、https://www.home-assistant.io/integrations/local_calendar/ ：本地待办/购物/菜单日历和自动化。https://github.com/michiel-dewilde/ha-mealplan 可作为菜单联动候选（需 HA 2026.7+，英语/荷兰语界面，GPL-3.0-or-later），优先简单原生实现。
- HA 渲染候选 https://github.com/cryptomilk/hass-eink-dashboard （Apache-2.0，作者标注 beta）：HA 内部 SVG/resvg 生成 PNG，无独立服务器/浏览器，视觉编辑、CJK 字体、ETag、Kindle 拉取，默认60秒渲染，短周期性能未验证。图片 URL 无认证是安全缺口，须解决；分辨率以实机核实。替代 https://github.com/the-louie/paperboard （Apache-2.0，需 HA 2026.3+，作者有分时布局，中文与 Kindle 适配未验证），暂不并行开发。
- Kindle 越狱 https://kindlemodding.org/jailbreaking/index.html ；https://github.com/NiLuJe/FBInk ；https://github.com/estcarisimo/paperwhite-weather 为图片刷新及恢复参考（作者15分钟级案例不证明高频可用）。型号/固件、客户端兼容性、许可和恢复仍需核实。
- HA 备份 https://www.home-assistant.io/common-tasks/general/backups/ ，社区集成更新 https://www.home-assistant.io/integrations/marketplace/ （2026.11+，旧版本 HACS）；不强制升级或额外开发更新平台。
