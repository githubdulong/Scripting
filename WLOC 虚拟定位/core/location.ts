// DVT 的位置模拟服务——与 Xcode 的 Simulate Location 走同一个接口。

import { archivedArg, DtxConnection } from "./dtx";
import { archiveDouble } from "./keyed_archive";

const SERVICE_IDENTIFIER = "com.apple.instruments.server.services.LocationSimulation";

/**
 * 下发前校验坐标。
 *
 * 链接解析、手动输入、坐标系换算任一环出问题都可能带出 NaN 或越界值，
 * 发给设备只会得到一个难懂的 DVT 错误，不如在这里拦掉。
 * 与 wloc（iOS）原生引擎的 `LocationCoordinates::validated` 同口径。
 */
export function validateCoordinate(latitude: number, longitude: number): void {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new Error(`坐标超出有效范围：${latitude}, ${longitude}`);
  }
}

export class LocationSimulation {
  private constructor(
    private readonly dtx: DtxConnection,
    private readonly channel: number,
  ) {}

  static async open(dtx: DtxConnection): Promise<LocationSimulation> {
    const channel = await dtx.makeChannel(SERVICE_IDENTIFIER);
    return new LocationSimulation(dtx, channel);
  }

  async set(latitude: number, longitude: number): Promise<void> {
    validateCoordinate(latitude, longitude);
    const identifier = await this.dtx.callMethod(
      this.channel,
      "simulateLocationWithLatitude:longitude:",
      [archivedArg(archiveDouble(latitude)), archivedArg(archiveDouble(longitude))],
      true,
    );
    await this.dtx.waitForReply(identifier);
  }

  /** 结束模拟，设备恢复真实定位。 */
  async clear(): Promise<void> {
    const identifier = await this.dtx.callMethod(this.channel, "stopLocationSimulation", [], true);
    await this.dtx.waitForReply(identifier);
  }
}
