import type { ReactNode } from "react";
import { Pressable, View, type ColorValue } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useId } from "react";
import { AppText } from "../../components/AppText";

export function CollapsibleUserMessageBody(props: {
  children: ReactNode;
  collapsible: boolean;
  expanded: boolean;
  backgroundColor: ColorValue;
  onToggle: () => void;
}) {
  const fadeId = useId();
  const collapsed = props.collapsible && !props.expanded;
  return (
    <View style={{ minWidth: 0, flexShrink: 0 }}>
      <View style={collapsed ? { maxHeight: 176, overflow: "hidden" } : undefined}>
        {/* Keep Markdown's natural height; clip the preview without squeezing its blocks. */}
        <View style={{ flexShrink: 0, minWidth: 0 }}>{props.children}</View>
        {collapsed ? (
          <View
            pointerEvents="none"
            accessible={false}
            style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 28 }}
          >
            <Svg width="100%" height="100%">
              <Defs>
                <LinearGradient id={fadeId} x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor={props.backgroundColor} stopOpacity="0" />
                  <Stop offset="1" stopColor={props.backgroundColor} />
                </LinearGradient>
              </Defs>
              <Rect width="100%" height="100%" fill={`url(#${fadeId})`} />
            </Svg>
          </View>
        ) : null}
      </View>
      {props.collapsible ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: props.expanded }}
          onPress={props.onToggle}
          className="min-h-11 justify-center"
        >
          <AppText className="text-sm font-t3-medium text-user-bubble-foreground">
            {props.expanded ? "Show less" : "Show full message"}
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );
}
