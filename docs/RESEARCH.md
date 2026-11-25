# 关键可行性证据（2026-11-25）
只保留影响选型和下一步的公开证据。真实家庭配置、密钥与原始业务响应不提交仓库。

## 数据接口
- 公交（硬性阻塞）：上海政府公共数据开放平台 https://data.sh.gov.cn/ 。个人墨水屏案例 https://www.lab-z.com/bsshow/ 、https://www.eetree.cn/project/detail/5310 报告实名取得 Token；资源 sod-p4pm95e968tfxhil41cotzxyn。案例含线路/站点 ID 及上下行，但计划发车不能证明在途 ETA。当前网页访问返回412，未持合法 Token 执行接口，免费额度、授权、真实多车 ETA 均未验收。随申行 https://open-web.shmaas.cn/docs/guide/ 的 getBusStopArriveDetails 需要商务凭证及出口 IP，个人免费授权不明确。Code410 两次公开示例实测均 HTTP 200、业务码200，但车辆与 ETA 记录均为0，排除为正式依赖，除非有新证据。其他上游授权不明或失效的接口不重复调查。
- 驾车（硬性阻塞）：高德 https://lbs.amap.com/api/webservice/guide/api/newroute 、https://lbs.amap.com/pages/base_service_price ，个人基础额度有公开说明，仍需自有合法 Key 验证所需实时路况、持续免费权限和缓存许可。百度 https://lbsyun.baidu.com/docs/webapi?title=directionv2%2Fdirection-api-v2 为备选。未做授权实测，不视为可用。不购买服务。
- 天气预报：Open-Meteo https://open-meteo.com/en/pricing 非商业免费限额1万次/日，两个公开样例运行均 URLError；暂不作为唯一天气源。MET Norway https://api.met.no/weatherapi/locationforecast/2.0/ （按服务条款标明 User-Agent、遵守缓存及署名要求）公开上海城市示例实际 HTTP 200，基础预报字段及时间存在，尚未验收全部天气字段、预警和本地连通性。
- 空气质量：Open-Meteo Air Quality https://open-meteo.com/en/docs/air-quality-api 公开示例实测 HTTP 200，PM2.5、PM10、AQI 字段存在；全球模式数据并非本地官方监测站实时观测，AQI 口径须标明。实际部署访问、准确度及免费长期使用仍需验证。
- 实测证据：临时诊断 PR #1（不合并），Actions runs 45587732018、45587887368（https://github.com/yudacheng666/KindleHomeDashboard/actions/runs/45587887368）。均使用无关公开示例，无秘密、私有参数及原始响应日志；第二轮 MET Norway 成功，Open-Meteo 预报重试失败，Code410 再次零记录。基础仓库检查成功不代表业务通过。没有 NAS 本地连通性或指定线路实测结论。

## 独立后端复用参考
- HA 官方 REST https://developers.home-assistant.io/docs/api/rest/ ，原生待办、购物清单和日历可按需接入，核心通勤不得依赖 HA。
- 驾车参考 https://github.com/DavisDL-89/amap_commute ，未审查完整代码及许可。
- Kindle 越狱 https://kindlemodding.org/jailbreaking/index.html ；https://github.com/NiLuJe/FBInk ；https://github.com/estcarisimo/paperwhite-weather 为图片刷新及恢复参考（15分钟案例不证明高频可用）。设备型号及固件未确定，客户端兼容、许可、安全与恢复待核验。
- 原 HA 整体后端比较已结束，不再推进 HA 渲染集成选型；以 docs/ARCHITECTURE.md 为准。
