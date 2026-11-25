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
