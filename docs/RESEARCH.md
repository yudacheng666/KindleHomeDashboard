# 有效技术证据
## 数据源
- 公交：上海公共数据开放平台资源 [公交实时信息](https://data.sh.gov.cn/view/detail/index.html?id=O1518422872025001&type=jk)，[个人墨水屏案例](https://www.lab-z.com/bsshow/) 报告实名取得 Token；资源标识 sod-p4pm95e968tfxhil41cotzxyn。示例仅证明接入与计划发车字段，真实在途多车 ETA 和免费额度需合法授权实测。当前资源详情访问返回412，不等同服务失效。备用 [随申行正式到站详情](https://open-web.shmaas.cn/docs/public-traffic/查询公交到站详情/) 明确最近两车 ETA 字段，个人免费接入未确认。
- 免费第三方 [Code410](https://www.code410.com/api/231)：公共示例请求 HTTP/业务码200，但复核确认 data 为字符串，未取得可识别 ETA；原零记录判断不能证明服务失效。正式依赖未验收。重要证据：[纠正响应结构测试](https://github.com/yudacheng666/KindleHomeDashboard/actions/runs/45589022807)。低免费额度、无授权或已失效的方案不重复调查。
- [chelaile-api-server](https://github.com/Justintunsday/chelaile-api-server)（MIT）有独立 HTTP 封装，可参考线路/站点/方向及批量刷新；其文档明确部分查询仅最近车辆有 ETA。[hacs-chelaile](https://github.com/2107596808/hacs-chelaile) 有多车展示参考，但上游逆向访问授权未确认，不直接采用。代码许可不等于数据授权。
- 驾车：[高德路径规划](https://lbs.amap.com/api/webservice/guide/api/newroute)、[基础额度](https://lbs.amap.com/pages/base_service_price)、[协议](https://lbs.amap.com/pages/terms)，[百度备选](https://lbsyun.baidu.com/docs/webapi?title=directionv2%2Fdirection-api-v2)。需自有合法 Key、免费使用许可和实时路况实际响应；未验收。
- 天气：[MET Norway](https://api.met.no/weatherapi/locationforecast/2.0/) 基础预报、[Open-Meteo Air Quality](https://open-meteo.com/en/docs/air-quality-api) 空气质量字段已在公共示例实测取得；后者为模型数据，AQI 口径需标明。Open-Meteo 预报网络探测失败，非唯一来源。证据 [测试1](https://github.com/yudacheng666/KindleHomeDashboard/actions/runs/45587732018)、[测试2](https://github.com/yudacheng666/KindleHomeDashboard/actions/runs/45587887368)。完整字段、服务条款、NAS 本地及长期运行仍待验证。
## 复用参考
- [HA REST](https://developers.home-assistant.io/docs/api/rest/) 按需接入，核心通勤独立运行。
- [Kindle 越狱](https://kindlemodding.org/jailbreaking/index.html)、[FBInk](https://github.com/NiLuJe/FBInk)、[paperwhite-weather](https://github.com/estcarisimo/paperwhite-weather)；设备兼容、许可、15–30秒级刷新与恢复待实测。
