"""
从 OpenStreetMap 的中国数据包（Geofabrik china-latest.osm.pbf）里取出高速公路（highway=motorway）：
每条路段的节点编号、经纬度与标签（编号 ref、名称、开通日期 start_date / opening_date）。
输出 JSON，交给 build.ts 推断开通年份并生成视频用的数据。

    python video/expressway/data/extract-osm.py <china-latest.osm.pbf> <out.json>

Geofabrik 的中国数据包按 OSM 里中华人民共和国的边界切出，不含台湾、香港、澳门的路网
（与国家统计局"全国数据不含港澳台"的口径一致）。
"""
import json
import sys

import osmium

KEEP = ('ref', 'name', 'name:en', 'start_date', 'opening_date', 'oneway', 'lanes')


class Motorways(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ways = []

    def way(self, w):
        if w.tags.get('highway') != 'motorway':
            return
        coords = []
        ids = []
        for n in w.nodes:
            if not n.location.valid():
                continue
            ids.append(n.ref)
            coords.append(round(n.location.lon, 6))
            coords.append(round(n.location.lat, 6))
        if len(ids) < 2:
            return
        tags = {k: w.tags.get(k) for k in KEEP if k in w.tags}
        self.ways.append({'id': w.id, 'n': ids, 'c': coords, 't': tags})


src, out = sys.argv[1], sys.argv[2]
h = Motorways()
# 节点坐标放在内存索引里（中国数据包的节点数在 sparse 索引能承受的范围内）
h.apply_file(src, locations=True, idx='flex_mem')
with open(out, 'w', encoding='utf-8') as f:
    json.dump(h.ways, f, ensure_ascii=False, separators=(',', ':'))
print(f'{len(h.ways)} motorway ways -> {out}')
