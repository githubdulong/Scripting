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
  GeometryReader,
  MapUserLocationButton,
  MapCompass,
  MapPitchToggle,
  MapScaleView,
  VStack,
  Image,
  ZStack,
  type MapSelectionValue,
  type GeometryProxy,
  type Point,
} from "scripting";
import type { Coordinate, ActiveLocation, MapLayerId } from "../types";
import { DEFAULT_SPAN } from "../constants";
import { loadActiveCache } from "../utils/storage";
import { fromDeviceCoordinate } from "../utils/coords";

// 从 MapCameraPosition 中提取中心坐标
function getCoordFromPosition(pos: MapCameraPosition): Coordinate | null {
  if (pos.region) return { latitude: pos.region.center.latitude, longitude: pos.region.center.longitude };
  if (pos.camera) return { latitude: pos.camera.centerCoordinate.latitude, longitude: pos.camera.centerCoordinate.longitude };
  if (pos.rect) return { latitude: pos.rect.center.latitude, longitude: pos.rect.center.longitude };
  if (pos.item) return { latitude: pos.item.coordinate.latitude, longitude: pos.item.coordinate.longitude };
  return null;
}

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
  /** 当前相机姿态下点选不可用（3D / 旋转），由调用方提示用户。 */
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

  /**
   * 相机当前框住的经纬范围。
   *
   * 双向绑定在手势结束后回写的不一定还是 region 形式——也可能是 rect（米制尺寸）
   * 或 camera（视点式）。只认 region 的话，用户一拖动地图就再也换算不出坐标了。
   */
  function visibleSpan(): { center: Coordinate; latitudeDelta: number; longitudeDelta: number } | null {
    const position = cameraPosition.value;

    const region = position.region;
    if (region) {
      return {
        center: region.center,
        latitudeDelta: region.span.latitudeDelta,
        longitudeDelta: region.span.longitudeDelta,
      };
    }

    const rect = position.rect;
    if (rect) {
      // size 是米，换成度。经度那一轴随纬度收缩，要乘 cos。
      const cos = Math.max(0.01, Math.cos((rect.center.latitude * Math.PI) / 180));
      return {
        center: rect.center,
        latitudeDelta: rect.size.height / 111_320,
        longitudeDelta: rect.size.width / (111_320 * cos),
      };
    }

    return null;
  }

  /**
   * 把点击位置换算成坐标——这就是「点哪选哪」。
   *
   * Scripting 没有 MapKit 的 MapReader/proxy.convert，但该有的料都在：
   * 相机给出中心与跨度，GeometryReader 给出视图尺寸，线性插值即可。
   * 地图是墨卡托投影、纬度并非严格线性，不过在城市级跨度下误差只有米级。
   *
   * 取不到跨度时返回 null，由调用方提示——默默退回地图中心会表现成
   * 「点哪都选中间」，比不响应更难查。
   * 相机被倾斜或旋转的情况在调用处单独处理（会先把相机摆正）。
   */
  function coordinateAtPoint(point: Point, size: { width: number; height: number }): Coordinate | null {
    const span = visibleSpan();
    if (!span || size.width <= 0 || size.height <= 0) return null;

    return {
      latitude: span.center.latitude + (0.5 - point.y / size.height) * span.latitudeDelta,
      longitude: span.center.longitude + (point.x / size.width - 0.5) * span.longitudeDelta,
    };
  }

  /*
    这几个 Observable 必须在 **本组件自己的 render 里**读。

    下面的地图内容写在 GeometryReader 的子闭包里，在那里读 `.value` 订阅
    建立不到本组件身上——表现就是「底部坐标卡在变、地图上的绿箭头不动」
    （底部卡片在 index.tsx 自己的 render 里读，所以正常）。
    在这里读一次，闭包里只用这些普通值。
  */
  /** 换算不可用（相机是 camera 形态）：点击会落到地图中心，这时把准星露出来。 */
  const centerPickOnly = cameraPosition.value.camera !== null;

  const active = activeLoc.value;
  const pickedLat = coordLat.value;
  const pickedLng = coordLng.value;

  return (
    <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      <GeometryReader>
        {(proxy: GeometryProxy) => (
          <Map
            cameraPosition={cameraPosition}
            selection={mapSelection}
            /* 点中地点时弹苹果自带的详情卡（名称、类别、营业信息等），样式交给系统决定 */
            featureSelectionAccessory="automatic"
            mapStyle={mapStyle}
            frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
            onTapGesture={{
              perform: (location: Point) => {
                const picked = coordinateAtPoint(location, proxy.size);
                if (picked) {
                  onCoordChange(picked.latitude, picked.longitude);
                  return;
                }

                /*
                  算不出「点到哪」：相机是 camera 形态（倾斜、旋转，或系统就这么
                  回写的），那是透视投影，平面插值不成立。

                  以前是拒绝 + 提示去摆正。但回写成什么形态由 MapKit 决定，摆正后
                  下次手势可能又变回去，于是提示没完没了——这就是那句话一直冒出来
                  的原因。
                  现在退一步：落到**地图中心**。这个值四种形态下都读得到，永远准。
                  界面上那个准星就是在告诉你会落在哪。
                */
                const center = getCoordFromPosition(cameraPosition.value);
                if (center) {
                  onCoordChange(center.latitude, center.longitude);
                  onPickUnavailable();
                }
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
      </GeometryReader>

      {/*
        准星。
        只在「点哪选哪」失效时出现（相机被倾斜或旋转），这时点击落到地图中心，
        准星标的就是那个中心。平时不显示，免得白挡着地图。
      */}
      {centerPickOnly ? (
        <VStack spacing={2} allowsHitTesting={false}>
          <Image systemName="plus" foregroundStyle="systemRed" font="title2" />
          <Text
            font="caption2"
            foregroundStyle="white"
            padding={{ vertical: 2, leading: 8, trailing: 8 }}
            background={{ style: "rgba(0,0,0,0.55)", shape: "capsule" }}
          >
            点击选中此处
          </Text>
        </VStack>
      ) : null}
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
