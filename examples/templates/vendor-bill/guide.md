# 供应商月度账单

- 只整理数据，不要写 HTML。字段见 `dview template show vendor-bill`。
- `price` 填不含税单价，`qty` 填数量；**不要自己算金额、小计、税额和合计**，页面和导出会按数量 × 单价计算。
- `taxRate` 是小数（6% 填 0.06）；没有税就不填。
- 日期用 `YYYY-MM-DD`，账期用 `YYYY-MM`。
- 金额、数量必须是数字，不要带货币符号或千分位逗号。
- 数据文件放在仓库里固定的位置（如 `bills/<客户>-<账期>.json`），以后改数据重新渲染会更新原链接。
- 生成：`dview render vendor-bill --data <数据文件> --json -m "<改了什么>"`。
