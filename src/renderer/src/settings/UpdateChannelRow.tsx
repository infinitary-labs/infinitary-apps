import type { UpdateChannel } from "@shared/update";
import { UPDATE_WORDS } from "@shared/updateWords";
import { useEffect } from "react";
import { chooseUpdateChannel, refreshUpdateStatus, useUpdateState } from "../app/updateState";
import { Button, GroupedPills } from "../design";
import { SettingRow } from "./settingRows";

/** INF-640: one installed app remembers Stable or Alpha, beside Version. */
export function UpdateChannelRow() {
  const { status, problem } = useUpdateState();
  useEffect(() => {
    void refreshUpdateStatus();
  }, []);
  if (!status?.channelChoice)
    return status?.problem ? (
      <SettingRow
        id="update-channel"
        title={UPDATE_WORDS.channel}
        description=""
        control={null}
        error={status.problem}
      />
    ) : null;
  return (
    <SettingRow
      id="update-channel"
      title={UPDATE_WORDS.channel}
      description="Stable follows published releases. Alpha includes early releases. Changing channels never installs an older version."
      error={problem ?? status.problem}
      detail={
        <div
          style={{ marginTop: "var(--space-2)", color: "var(--fg-2)", fontSize: "var(--text-sm)" }}
        >
          <span role="status">
            {status.phase === "checking"
              ? "Checking for updates…"
              : status.phase === "ready"
                ? "Restart to finish updating before changing channels."
                : status.phase === "installing"
                  ? "Infinitary is finishing the update."
                  : status.notice}
          </span>
          {status.phase === "error" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void refreshUpdateStatus();
              }}
            >
              Try again
            </Button>
          )}
        </div>
      }
      control={
        <GroupedPills<UpdateChannel>
          name={UPDATE_WORDS.channel}
          htmlName="update-channel"
          value={status.channel}
          disabled={status.phase === "installing" || status.phase === "ready"}
          options={[
            { value: "stable", label: "Stable" },
            { value: "alpha", label: "Alpha" },
          ]}
          onChange={(next) => {
            void chooseUpdateChannel(next);
          }}
        />
      }
    />
  );
}
