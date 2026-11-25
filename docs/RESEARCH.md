# 有效技术证据
## 数据源
- 公交新候选：[shmaas-2025-statics](https://github.com/EthanYLin/shmaas-2025-statics)（MIT）的 lib/bus-api.ts 使用 api.shmaas.net，未携带密钥。2026-11-25 无关公共示例真实网络测试取得 HTTP 200、业务码0、线路25站、两辆不同车辆的非空数值 ETA/距离/剩余站数；[实测证据](https://github.com/yudacheng666/KindleHomeDashboard/actions/runs/45612964043)。目标线路的公共末端两站取得同车 ETA，短间隔复测同车距离变化且曾短暂返回空值；仍未独立核验实际到站误差及目标线路两车 ETA。上海市交通委相关说明 https://sh.people.com.cn/n2/2023/0412/c176737-40373436.html 与随申行官方数据服务 https://www.shmaas.cn/solution/apiInterfaceService.html 支持公交企业调度系统与官方交通数据汇聚的背景，不能独立证明 .net 接口运营归属或开放许可。正式网关 https://open-web.shmaas.cn/docs/guide/ 明确要求商户身份、签名、出口 IP，并列出频率限制错误码，但未公开具体阈值；不适用于推定免密钥接口额度。免密钥调用仅证实短期技术可行，长期免费、自动访问许可、限额、SLA、源刷新周期未确认，不正式依赖或高频调用。无访问控制绕过。
- 正规公交备选：[上海公共数据开放平台](https://data.sh.gov.cn/view/detail/index.html?id=O1518422872025001&type=jk)及[个人墨水屏案例](https://www.lab-z.com/bsshow/)报告实名取得 Token；资源 sod-p4pm95e968tfxhil41cotzxyn。指定资源开放条件、免费额度及在途 ETA 未验收，网页访问412。[随申行开放平台](https://open-web.shmaas.cn/docs/guide/)正式多车 ETA 需商务凭证，个人免费权限未知。
- 第三方公交：Code410 公共示例返回字符串而非车辆数据；极数本源当前免费20次/日，不满足需求。未确认授权的非公开逆向接口不作为正式依赖。
- 驾车：[高德路径规划](https://lbs.amap.com/api/webservice/guide/api/newroute)、[基础额度](https://lbs.amap.com/pages/base_service_price)、[协议](https://lbs.amap.com/pages/terms)，[百度备选](https://lbsyun.baidu.com/docs/webapi?title=directionv2%2Fdirection-api-v2)。需自有合法 Key、免费使用许可和实时路况实际响应；未验收。
- 天气：[MET Norway](https://api.met.no/weatherapi/locationforecast/2.0/) 基础预报、[Open-Meteo Air Quality](https://open-meteo.com/en/docs/air-quality-api) 空气质量字段已在公共示例实测取得；后者为模型数据，AQI 口径需标明。Open-Meteo 预报网络探测失败，非唯一来源。证据 [测试1](https://github.com/yudacheng666/KindleHomeDashboard/actions/runs/45587732018)、[测试2](https://github.com/yudacheng666/KindleHomeDashboard/actions/runs/45587887368)。完整字段、服务条款、NAS 本地及长期运行仍待验证。
## 复用参考
- [BusArrivalBoard](https://github.com/Garfield-Wuu/BusArrivalBoard)（MIT）：Python 独立后端、墨水屏帧服务、变化检测和多车显示；其车来了数据源授权未确认，仅参考独立显示与缓存机制。
- [HA REST](https://developers.home-assistant.io/docs/api/rest/) 按需接入，核心通勤独立运行。
- [Kindle 越狱](https://kindlemodding.org/jailbreaking/index.html)、[FBInk](https://github.com/NiLuJe/FBInk)、[paperwhite-weather](https://github.com/estcarisimo/paperwhite-weather)；设备兼容、许可、15–30秒级刷新与恢复待实测。
