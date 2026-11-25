# 可行性调研 — 2026-11-25
以下为公开候选技术的文档证据，不代表任何私有部署地点、真实接口测试或硬件验收。
## 公交（首要阻塞）
随申行开放平台 https://open-web.shmaas.cn/docs/category/公共交通服务/ 与 https://open-web.shmaas.cn/docs/guide/：公开文档提供 queryBusLine、getBusStopArriveDetails；接口输入线路/站点编号和上下行；输出最近和后续车辆 ETA、距离及站数，线路接口提供站序和首末班。待确认授权主体、费用、额度、覆盖、响应状态语义与更新时间。不得将计划发车字段当成实时 ETA。正式调用前获得授权，真实站点/方向仅私有验证，不在公开文档记载。消费端实时公交可作为交叉核对，不等同于开放 API 权限。非公开逆向接口不采用；车来了第三方项目本轮无法读取，不作授权依据。高德、百度公交路径规划不能替代车辆 ETA。
## 驾车
https://lbs.amap.com/api/webservice/guide/api/newroute 、https://developer.amap.com/api/webservice/guide/api-advanced/advanced-path 、https://lbs.amap.com/pages/base_service_price ：高德正式路径规划及路况服务；基础个人认证驾车月额度参考15万，实际权限及高级路况费用待账户确认。https://lbsyun.baidu.com/docs/webapi?title=directionv2%2Fdirection-api-v2 ：百度备选实时路况算路；实际耗时字段与权限须验证。先用公开虚构路线合法测试，再经授权私有配置实测。禁止把历史均值当成实时。
## Kindle
https://kindlemodding.org/jailbreaking/index.html 按型号及固件确定路径，暂不执行；https://github.com/NiLuJe/FBInk 提供直接 framebuffer 图片/文字及刷新控制，GPLv3 系列许可，发行时需审查义务。https://github.com/estcarisimo/paperwhite-weather 提供 PW3 固件5.16.2.1.1 的作者实机记录，KUAL/MRPI/SSH，USB 安装仍为草案；研究客户端、恢复与刷新，不等同于本设备兼容。https://github.com/zihengjackchen/kindle-dashboard MIT，作者记录1072x1448设备，NAS/Pillow渲染、缓存与触摸，有前台防休眠选项，深度休眠下保持显示未实现，不能直接假定秒级更新。https://github.com/jefftko/kindle-dashboard 作者在 Oasis 3 验证 FBInk/KUAL/shell，系统接口因代际不同；中文字体与恢复值得参考。尚未逐项审查上游代码、许可证及近期维护历史，复制前必须完成。
## 家庭功能
https://www.home-assistant.io/integrations/local_todo/ 与 https://www.home-assistant.io/integrations/shopping_list/ 原生待办购物可复用；https://www.home-assistant.io/integrations/open_meteo/ 免费无 key 天气候选，预警与空气质量覆盖另核实。Apple 提醒事项同步尚未验证。
## 验证顺序
官方授权及配额 → 公交线路/方向/ID/ETA私有实测 → 驾车真实交通数据 → 设备型号和固件、NAS Docker/资源 → 架构与界面审批 → 实施。当前只有文档调研，不存在真实接口或硬件通过证据。

补充：随申行网关需对接方提供网络出口 IP，平台邮件发放域名、MerchantId 与签名盐值；个人申请、动态公网 IP/家庭 NAT 是否可接受尚不明确。先咨询公开商务邮箱 DataBD@shmaas.cn，不发送私有路线或家庭 IP。高德高级公交信息查询 https://lbs.amap.com/api/webservice/guide/api-advanced/bus-inquiry 提供站点/线路 ID 和关键字查询，有体验配额，可用于公开线路拓扑验证，但非实时 ETA，供应商 ID 不可假定互通。paperwhite-weather 为 MIT，作者记录15分钟刷新、重启自动恢复，不能直接证明15秒高频可行。

## 2026-11-25 第二轮：个人公交数据源
优先级调整为政府公共数据开放平台（在线接入候选），不再以商务邮件为前置。
- 2026 M-Design 墨水屏公交案例：https://www.lab-z.com/bsshow/ （2026-11-23）及 https://www.eetree.cn/project/detail/5310 。作者报告个人实名取得 Token，使用上海公共数据开放平台的 POST 接口，资源标识 sod-p4pm95e968tfxhil41cotzxyn；参数 cityCode、isGetStopArrive、lon、lat、limit、offset、coordinateType，使用 WGS84，响应含 lineId、stopId、upDown。文章展示的 JSON 片段主要为 dispatchCarSchedule（计划发车），不得将其作为在途 ETA 验收证据。案例仅为第三方实测。官方平台主页本轮网页访问返回 412，接口 URL 无法通过当前网页工具读取；未发出带合法 Token 的 POST，资源的现行开放类别、配额、有效期、费用与真实 ETA 待核实。政府规则 https://www.shanghai.gov.cn/sjaqsj/20250724/b07f46d764f24bc9abc93a9e5606c025.html 区分无条件与有条件开放；个人可申请并按协议使用，不能推断所有资源都免费或无限额。
- Code410 https://www.code410.com/api/231 2026-06-15 文档称免费 GET、全站10万次/日，字段线路/终点/ETA/剩余站数。实际打开不带参数的公开 URL https://api.code410.com/api/traffic/bus 取得 JSON 业务提示需要城市与站点；带无关公共示例站点的查询无法由网页工具读取，不能判断是工具限制还是服务故障。未收到车辆数据。来源授权、单用户额度、多车、稳定性未确认；不作正式依赖。
- 极数本源 https://apizero.cn/aidocs/bus-realtime/raw.md ：POST，匿名5次/日、登录20次/日、会员5万次/日起；有站台和多车 ETA 结构，但免费额度不足以支撑每15–30秒采集（每小时120–240次）。上游授权与实际覆盖待核实；未实测，不购买会员。
- https://github.com/2107596808/hacs-chelaile 作者实现 HA 集成，默认30秒轮询；https://github.com/afterglowsdev/chelaile-api-collect 作者记录2026-03-18其他城市实时数据与旧接口停用；https://github.com/Justintunsday/chelaile-api-server 提供 HTTP 封装，两个公共实例健康检查均无法由网页工具读取。以上是第三方逆向适配，未确认上游授权，不采用绕过访问控制或违反条款的方式，不因开源而推断数据授权。可借鉴状态结构与调度。https://github.com/JerryChin/shanghai-bus-api 因接口失效于2022年归档。https://api.aa1.cn/doc/gjc.html 公布监测记录故障3015次、正常208次，不适合核心依赖。
- 驾车：高德 https://lbs.amap.com/api/webservice/guide/api/newroute (2026-06-17) 和百度 https://lbsyun.baidu.com/docs/webapi?title=directionv2%2Fdirection-api-v2 (2026-03-19) 官方文档复核，后者明确实时路况算路；均需正式 Key/AK，未实测。高德协议 https://lbs.amap.com/pages/terms 对数据存储、缓存及非开放内部数据使用有限制，设计时核实许可，不默认长期保存路况。
本轮未发送咨询邮件、未调用真实私有线路、未新开通账号/服务、未提交真实配置，未得到指定线路真实 ETA。当前阶段继续数据源验证而非开发或硬件操作。
