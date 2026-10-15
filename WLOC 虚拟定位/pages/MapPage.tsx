// 地图展示组件：纯地图 + 标记 + 图层切换按钮（右下角）。
// 坐标显示和操作按钮已移至 index.tsx App 层；顶部工具栏已统一到 index.tsx。

import {
  useEffect,
  useObservable,
  useRef,
  Map,
  Marker,
  MapPolyline,
  MapCircle,
  Annotation,
  Text,
  MapReader,
  MapUserLocationButton,
  MapCompass,
  MapPitchToggle,
  MapScaleView,
  ZStack,
  type MapSelectionValue,
  type MapProxy,
  type Point,
} from "scripting";
import type { Coordinate, ActiveLocation, MapLayerId } from "../types";
import { DEFAULT_SPAN } from "../constants";
import { loadActiveCache } from "../utils/storage";
import { fromDeviceCoordinate } from "../utils/coords";


interface MapPageProps {
  pendingCoord: Observable<Coordinate | null>;
  coordLat: Observable<number>;
  coordLng: Observable<number>;
  /** 正在模拟的位置，另画一个绿点与选点区分。 */
  activeLoc: Observable<ActiveLocation | null>;
  /** 已规划的全部方案，备选画浅色，选中的压在最上层。 */
  routes: Coordinate[][];
  selectedRouteIndex: number;
  /** 位置扰动半径（米），0 表示关闭——画成圆圈让范围看得见。 */
  jitterRadius: number;
  /** 手绘路径的点位，按顺序编号标出来。 */
  drawnPath: Coordinate[];
  layer: Observable<MapLayerId>;
  onCoordChange: (lat: number, lng: number, name?: string) => void;
  /** 地图投影暂时取不到（刚挂载、或已卸载），由调用方提示用户。 */
  onPickUnavailable: () => void;
}

export function MapPage({
  pendingCoord,
  coordLat,
  coordLng,
  activeLoc,
  layer,
  routes,
  selectedRouteIndex,
  jitterRadius,
  drawnPath,
  onCoordChange,
  onPickUnavailable,
}: MapPageProps) {
  const initialActive = loadActiveCache();

  // 相机位置：有缓存坐标则用缓存，否则 automatic
  const cameraPosition = useObservable<MapCameraPosition>(
    initialActive
      ? MapCameraPosition.region({
          center: { latitude: initialActive.latitude, longitude: initialActive.longitude },
          span: { latitudeDelta: DEFAULT_SPAN.latitudeDelta, longitudeDelta: DEFAULT_SPAN.longitudeDelta },
        })
      : MapCameraPosition.automatic(),
  );



  // POI 选点
  const mapSelection = useObservable<MapSelectionValue | null>(null);

  // 移动地图中心
  function moveCameraTo(lat: number, lng: number) {
    cameraPosition.setValue(
      MapCameraPosition.region({
        center: { latitude: lat, longitude: lng },
        span: { latitudeDelta: DEFAULT_SPAN.latitudeDelta, longitudeDelta: DEFAULT_SPAN.longitudeDelta },
      }),
    );
  }

  // 拖动地图只换视野，不改选中点——选中的是你点下的那个位置，图钉留在原地。
  // 外部跳转（搜索/收藏/链接解析）— 使用 subscribe 保证可靠监听
  useEffect(() => {
    const cb = (target: Coordinate | null) => {
      if (target) {
        moveCameraTo(target.latitude, target.longitude);
        onCoordChange(target.latitude, target.longitude);
        pendingCoord.setValue(null);
      }
    };
    pendingCoord.subscribe(cb);
    return () => pendingCoord.unsubscribe(cb);
  }, []);

  /*
   * 点中地图上的地点（POI）。
   *
   * 这是最省事的一条选点路径：MapKit 自己认得餐厅、车站、景点，点一下就精确命中，
   * 不用对准星。配合下面的 featureSelectionAccessory，还会弹出苹果自带的详情卡。
   */
  useEffect(() => {
    const cb = (sel: MapSelectionValue | null) => {
      if (sel && sel.type === "feature" && sel.coordinate) {
        moveCameraTo(sel.coordinate.latitude, sel.coordinate.longitude);
        onCoordChange(sel.coordinate.latitude, sel.coordinate.longitude, sel.title ?? undefined);
      }
    };
    mapSelection.subscribe(cb);
    return () => mapSelection.unsubscribe(cb);
  }, []);

  // 启动时：上次模拟的位置 → GPS 定位
  useEffect(() => {
    (async () => {
      const cached = initialActive;
      if (cached) {
        moveCameraTo(cached.latitude, cached.longitude);
        onCoordChange(cached.latitude, cached.longitude);
        return;
      }

      try {
        // GPS 给的是 WGS-84，摆到地图上要先转成地图系。
        const gps = await Location.requestCurrent({ forceRequest: true });
        if (gps) {
          const mapped = fromDeviceCoordinate(gps.latitude, gps.longitude);
          moveCameraTo(mapped.latitude, mapped.longitude);
          onCoordChange(mapped.latitude, mapped.longitude);
        }
      } catch {
        // 拿不到定位就维持 automatic 镜头，用户自己选点即可。
      }
    })();
  }, []);

  const mapStyle = layerToStyle(layer.value);

  const active = activeLoc.value;
  const pickedLat = coordLat.value;
  const pickedLng = coordLng.value;

  return (
    <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      {/*
        MapReader 给出地图自己的投影，点击位置直接换算成坐标。

        这块以前是手算的：从 cameraPosition 反推可视跨度、配合 GeometryReader
        的尺寸线性插值。问题是回写成哪种相机形态由 MapKit 决定（region / rect /
        camera / item），camera 形态下连跨度都拿不到，倾斜后更是透视投影、
        线性插值根本不成立——只能退回选地图中心并弹个准星。
        现在交给原生做，倾斜、旋转、任意缩放都准。
      */}
      <MapReader>
        {(proxy: MapProxy) => (
          <Map
            cameraPosition={cameraPosition}
            selection={mapSelection}
            /* 点中地点时弹苹果自带的详情卡（名称、类别、营业信息等），样式交给系统决定 */
            featureSelectionAccessory="automatic"
            mapStyle={mapStyle}
            frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
            onTapGesture={{
              perform: (location: Point) => {
                // 投影暂时取不到（刚挂载、或 reader 已卸载）时返回 null，
                // 这时什么都不做比给个错坐标强。
                const picked = proxy.convertPoint(location);
                if (picked) onCoordChange(picked.latitude, picked.longitude);
                else onPickUnavailable();
              },
            }}
            controls={
              <>
                <MapUserLocationButton />
                <MapCompass />
                <MapPitchToggle />
                <MapScaleView />
              </>
            }
          >
            {routes.map((coordinates, index) =>
              coordinates.length > 1 && index !== selectedRouteIndex ? (
                <MapPolyline
                  key={`alt-${index}`}
                  coordinates={coordinates}
                  strokeColor="rgba(120,120,128,0.45)"
                  /* 备选方案画虚线，和选中的实线一眼能分开 */
                  strokeStyle={{ lineWidth: 4, lineCap: "round", dash: [2, 8] }}
                />
              ) : null,
            )}
            {routes[selectedRouteIndex] && routes[selectedRouteIndex].length > 1 && (
              <MapPolyline
                coordinates={routes[selectedRouteIndex]}
                strokeColor="systemBlue"
                strokeStyle={{ lineWidth: 6, lineCap: "round", lineJoin: "round" }}
              />
            )}

            {/*
              位置扰动的范围。开了扰动后坐标会在这个圈里随机漂移，
              画出来才知道「几米」到底是多大一块。
            */}
            {jitterRadius > 0 && active ? (
              <MapCircle
                center={{ latitude: active.latitude, longitude: active.longitude }}
                radius={jitterRadius}
                fillColor="rgba(52,199,89,0.18)"
                strokeColor="systemGreen"
                /* 虚线圈：这是漂移范围，不是一个实际存在的边界 */
                strokeStyle={{ lineWidth: 1, dash: [4, 3] }}
              />
            ) : null}

            {/* 手绘路径的点位：只画折线看不出先后，编上号才知道怎么走 */}
            {drawnPath.map((point, index) => (
              <Annotation
                key={`drawn-${index}`}
                coordinate={point}
                anchor="center"
              >
                <Text
                  font="caption2"
                  fontWeight="bold"
                  foregroundStyle="white"
                  frame={{ width: 22, height: 22 }}
                  background={{ style: "systemIndigo", shape: "circle" }}
                >
                  {String(index + 1)}
                </Text>
              </Annotation>
            ))}

            {/* 选中的位置：点哪它就落在哪，和 wloc 一致 */}
            {(pickedLat !== 0 || pickedLng !== 0) && (
              <Marker
                coordinate={{ latitude: pickedLat, longitude: pickedLng }}
                tint="systemRed"
                systemImage="mappin"
              />
            )}
            {active && (
              <Marker
                coordinate={{ latitude: active.latitude, longitude: active.longitude }}
                tint="systemGreen"
                systemImage="location.fill"
              />
            )}
          </Map>
        )}
      </MapReader>
    </ZStack>
  );
}

function layerToStyle(layer: MapLayerId) {
  switch (layer) {
    case "imagery":
      return { style: "imagery" as const, elevation: "realistic" as const };
    case "hybrid":
      return { style: "hybrid" as const, elevation: "realistic" as const, showsTraffic: true };
    case "standard":
    default:
      return { style: "standard" as const, showsTraffic: true };
  }
}
