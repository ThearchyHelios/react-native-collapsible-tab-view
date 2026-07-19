import React from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import PagerView from 'react-native-pager-view'
import Animated, {
  cancelAnimation,
  Extrapolation,
  interpolate,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  withDecay,
  withDelay,
  withTiming,
} from 'react-native-reanimated'
// reanimated 4 / worklets 0.8: runOnJS(fn)(args) 的柯里化形式会静默 no-op，
// 必须改用 worklets 的 scheduleOnRN(fn, args) / runOnUISync(fn, args)。
import { runOnUISync, scheduleOnRN } from 'react-native-worklets'

import { Context, TabNameContext } from './Context'
import { IS_IOS, ONE_FRAME_MS, scrollToImpl } from './helpers'
import { useAnimatedDynamicRefs, useContainerRef, useLayoutHeight, usePageScrollHandler, useTabProps } from './hooks'
import { Lazy } from './Lazy'
import { MaterialTabBar, TABBAR_HEIGHT } from './MaterialTabBar'
import { Tab } from './Tab'
import { CollapsibleProps, CollapsibleRef, ContextType, IndexChangeEventData, TabName } from './types'

const AnimatedPagerView = Animated.createAnimatedComponent(PagerView)

/** 切 tab 后逐帧回写滚动位置的最小同步间隔(见 syncScrollFrame) */
const SCROLL_SYNC_INTERVAL_MS = 100

/**
 * Basic usage looks like this:
 *
 * ```tsx
 * import { Tabs } from 'react-native-collapsible-tab-view'
 *
 * const Example = () => {
 *   return (
 *     <Tabs.Container renderHeader={MyHeader}>
 *       <Tabs.Tab name="A">
 *         <ScreenA />
 *       </Tabs.Tab>
 *       <Tabs.Tab name="B">
 *         <ScreenB />
 *       </Tabs.Tab>
 *     </Tabs.Container>
 *   )
 * }
 * ```
 */
export const Container = React.memo(
  React.forwardRef<CollapsibleRef, CollapsibleProps>(
    (
      {
        initialTabName,
        headerHeight: initialHeaderHeight,
        minHeaderHeight = 0,
        tabBarHeight: initialTabBarHeight = TABBAR_HEIGHT,
        revealHeaderOnScroll = false,
        snapThreshold,
        children,
        renderHeader,
        renderTabBar = (props) => <MaterialTabBar {...props} />,
        headerContainerStyle,
        cancelTranslation,
        containerStyle,
        lazy,
        cancelLazyFadeIn,
        pagerProps,
        onIndexChange,
        onTabChange,
        width: customWidth,
        allowHeaderOverscroll,
      },
      ref
    ) => {
      const containerRef = useContainerRef()

      const [tabProps, tabNamesArray] = useTabProps(children, Tab)

      const [refMap, setRef] = useAnimatedDynamicRefs()

      const windowWidth = useWindowDimensions().width
      const width = customWidth ?? windowWidth

      const [containerHeight, getContainerLayoutHeight] = useLayoutHeight()

      const [tabBarHeight, getTabBarHeight] =
        useLayoutHeight(initialTabBarHeight)

      const [headerHeight, getHeaderHeight] = useLayoutHeight(
        !renderHeader ? 0 : initialHeaderHeight
      )
      const initialIndex = React.useMemo(
        () =>
          initialTabName
            ? tabNamesArray.findIndex((n) => n === initialTabName)
            : 0,
        [initialTabName, tabNamesArray]
      )

      const contentInset = React.useMemo(() => {
        // Patched (RN 0.85/Fabric): iOS 原本靠 ScrollView 的 contentInset 预留 header
        // 空间,但 Fabric 不生效 → 内容焊死在屏幕顶端、滚动时与 header 脱节。改为 0,
        // header 空间统一靠 contentContainerStyle.paddingTop 预留(见 useCollapsibleStyle)，
        // 与 Android 一致。scroll handler 里的 `y + contentInset` 也因此归一化正确。
        return 0
      }, [headerHeight, tabBarHeight, allowHeaderOverscroll])

      const snappingTo: ContextType['snappingTo'] = useSharedValue(0)
      const offset: ContextType['offset'] = useSharedValue(0)
      const accScrollY: ContextType['accScrollY'] = useSharedValue(0)
      const oldAccScrollY: ContextType['oldAccScrollY'] = useSharedValue(0)
      const accDiffClamp: ContextType['accDiffClamp'] = useSharedValue(0)
      const scrollYCurrent: ContextType['scrollYCurrent'] = useSharedValue(0)
      const scrollY: ContextType['scrollY'] = useSharedValue(
        Object.fromEntries(tabNamesArray.map((n) => [n, 0]))
      )

      const isSlidingTopContainerValue = useSharedValue(false)
      const isSlidingTopContainerPrevValue = useSharedValue(false)
      const isTopContainerOutOfSyncValue = useSharedValue(false)
      const panScrollYValue = useSharedValue(0)

      const contentHeights: ContextType['contentHeights'] = useSharedValue(
        tabNamesArray.map(() => 0)
      )

      const tabNames: ContextType['tabNames'] = useDerivedValue<TabName[]>(
        () => tabNamesArray,
        [tabNamesArray]
      )
      const index: ContextType['index'] = useSharedValue(initialIndex)

      const focusedTab: ContextType['focusedTab'] =
        useDerivedValue<TabName>(() => {
          return tabNames.value[index.value]
        }, [tabNames])
      const calculateNextOffset = useSharedValue(initialIndex)
      const headerScrollDistance: ContextType['headerScrollDistance'] =
        useDerivedValue(() => {
          return headerHeight !== undefined ? headerHeight - minHeaderHeight : 0
        }, [headerHeight, minHeaderHeight])

      const indexDecimal: ContextType['indexDecimal'] =
        useSharedValue(initialIndex)

      const afterRender = useSharedValue(0)
      React.useEffect(() => {
        afterRender.value = withDelay(
          ONE_FRAME_MS * 5,
          withTiming(1, { duration: 0 })
        )
      }, [afterRender, tabNamesArray])

      const resyncTabScroll = () => {
        'worklet'
        for (const name of tabNamesArray) {
          scrollToImpl(
            refMap[name],
            0,
            scrollYCurrent.value - contentInset,
            false
          )
        }
      }

      // the purpose of this is to scroll to the proper position if dynamic tabs are changing
      useAnimatedReaction(
        () => {
          return afterRender.value === 1
        },
        (trigger) => {
          if (trigger) {
            afterRender.value = 0
            resyncTabScroll()
          }
        },
        [tabNamesArray, refMap, afterRender, contentInset]
      )

      // derived from scrollX
      // calculate the next offset and index if swiping
      // if scrollX changes from tab press,
      // the same logic must be done, but knowing
      // the next index in advance
      useAnimatedReaction(
        () => {
          const nextIndex = Math.round(indexDecimal.value)
          return nextIndex
        },
        (nextIndex) => {
          if (nextIndex !== null && nextIndex !== index.value) {
            calculateNextOffset.value = nextIndex
          }
        },
        []
      )

      const propagateTabChange = React.useCallback(
        (change: IndexChangeEventData<TabName>) => {
          onTabChange?.(change)
          onIndexChange?.(change.index)
        },
        [onIndexChange, onTabChange]
      )

      const syncCurrentTabScrollPosition = () => {
        'worklet'

        const name = tabNamesArray[index.value]
        scrollToImpl(
          refMap[name],
          0,
          scrollYCurrent.value - contentInset,
          false
        )
      }

      /*
       * We run syncCurrentTabScrollPosition in every frame after the index
       * changes for about 1500ms because the Lists can be late to accept the
       * scrollTo event we send. This fixes the issue of the scroll position
       * jumping when the user changes tab.
       * */
      const toggleSyncScrollFrame = (toggle: boolean) =>
        syncScrollFrame.setActive(toggle)
      const lastScrollSyncTime = useSharedValue(-SCROLL_SYNC_INTERVAL_MS)
      const syncScrollFrame = useFrameCallback(({ timeSinceFirstFrame }) => {
        // timeSinceFirstFrame 是浮点毫秒(120Hz 下为 8.33 的倍数)，`% 100 === 0`
        // 几乎永不命中 → 改为记录上次同步时间戳，距上次 ≥100ms 才同步一次。
        // setActive(true) 会让 timeSinceFirstFrame 从 0 重新计时，检测到回卷就
        // 重置基准，保证每次激活的第一帧立即同步。
        if (timeSinceFirstFrame < lastScrollSyncTime.value) {
          lastScrollSyncTime.value = timeSinceFirstFrame - SCROLL_SYNC_INTERVAL_MS
        }
        if (
          timeSinceFirstFrame - lastScrollSyncTime.value >=
          SCROLL_SYNC_INTERVAL_MS
        ) {
          syncCurrentTabScrollPosition()
          lastScrollSyncTime.value = timeSinceFirstFrame
        }
        if (timeSinceFirstFrame > 1500) {
          scheduleOnRN(toggleSyncScrollFrame, false)
        }
      }, false)

      useAnimatedReaction(
        () => {
          return calculateNextOffset.value
        },
        (i) => {
          if (i !== index.value) {
            offset.value =
              scrollY.value[tabNames.value[index.value]] -
              scrollY.value[tabNames.value[i]] +
              offset.value
            scheduleOnRN(propagateTabChange, {
              prevIndex: index.value,
              index: i,
              prevTabName: tabNames.value[index.value],
              tabName: tabNames.value[i],
            })
            index.value = i
            if (
              typeof scrollY.value[tabNames.value[index.value]] === 'number'
            ) {
              scrollYCurrent.value =
                scrollY.value[tabNames.value[index.value]] || 0
            }
            scheduleOnRN(toggleSyncScrollFrame, true)
          }
        },
        []
      )

      useAnimatedReaction(
        () => headerHeight,
        (_current, prev) => {
          if (prev === undefined) {
            // sync scroll if we started with undefined header height
            resyncTabScroll()
          }
        }
      )

      const headerTranslateY = useDerivedValue(() => {
        return revealHeaderOnScroll
          ? -accDiffClamp.value
          : -Math.min(scrollYCurrent.value, headerScrollDistance.value)
      }, [revealHeaderOnScroll])

      const stylez = useAnimatedStyle(() => {
        return {
          transform: [
            {
              translateY: headerTranslateY.value,
            },
          ],
          // zIndex 放进 animated style，跟 transform 同帧提交，避免
          // IOS_SYNCHRONOUSLY_UPDATE_UI_PROPS 下 transform 走同步路、zIndex 留在 shadow
          // tree 不同步 → header 在滚动时掉到内容后面。
          zIndex: 100,
        }
      }, [revealHeaderOnScroll])

      const onTabPress = React.useCallback(
        (name: TabName) => {
          const i = tabNames.value.findIndex((n) => n === name)

          if (name === focusedTab.value) {
            const ref = refMap[name]
            runOnUISync(
              scrollToImpl,
              ref,
              0,
              headerScrollDistance.value - contentInset,
              true
            )
          } else {
            containerRef.current?.setPage(i)
          }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [containerRef, refMap, contentInset]
      )

      useAnimatedReaction(
        () => tabNamesArray.length,
        (tabLength) => {
          if (index.value >= tabLength) {
            scheduleOnRN(onTabPress, tabNamesArray[tabLength - 1])
          }
        }
      )

      const pageScrollHandler = usePageScrollHandler({
        onPageScroll: (e) => {
          'worklet'
          indexDecimal.value = e.position + e.offset
        },
      })

      React.useImperativeHandle(
        ref,
        () => ({
          setIndex: (index) => {
            const name = tabNames.value[index]
            onTabPress(name)
            return true
          },
          jumpToTab: (name) => {
            onTabPress(name)
            return true
          },
          getFocusedTab: () => {
            return tabNames.value[index.value]
          },
          getCurrentIndex: () => {
            return index.value
          },
        }),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [onTabPress]
      )

      // useMemo：Gesture.Pan() 每次 render 重建会让 GestureDetector 反复
      // detach/attach 原生手势。闭包只捕获 shared values(引用稳定)与模块常量
      // IS_IOS，故 deps 可为空。
      const pan = React.useMemo(
        () =>
          Gesture.Pan()
            .activeOffsetY([ -10, 10 ])
            .onStart(() => {
              'worklet'
              cancelAnimation(scrollYCurrent)
            })
            .onUpdate((e) => {
              'worklet'
              if (!isSlidingTopContainerValue.value) {
                panScrollYValue.value = scrollYCurrent.value
                isSlidingTopContainerValue.value = true
                return
              }
              scrollYCurrent.value = interpolate(
                -e.translationY + panScrollYValue.value,
                [ 0, headerScrollDistance.value ],
                [ 0, headerScrollDistance.value ],
                Extrapolation.CLAMP,
              )
            })
            .onEnd((e) => {
              'worklet'
              if (!isSlidingTopContainerValue.value) {
                return
              }
              panScrollYValue.value = 0
              scrollYCurrent.value = withDecay({
                velocity: -e.velocityY,
                clamp: [ 0, headerScrollDistance.value ],
                deceleration: IS_IOS ? 0.998 : 0.99,
              }, (finished) => {
                isSlidingTopContainerValue.value = false
                isTopContainerOutOfSyncValue.value = !!finished
              })
            }),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        []
      )

      // 依赖数组列出 resyncTabScroll 闭包实际用到的 render 层值
      // (refMap/tabNamesArray/contentInset，写法对照上文 afterRender 的 reaction)，
      // 否则 refMap 更新后 worklet 仍持旧引用。
      useAnimatedReaction(() => scrollYCurrent.value - contentInset, (next, prev) => {
        if (next !== prev && isSlidingTopContainerValue.value) {
          resyncTabScroll()
        }
      }, [tabNamesArray, refMap, contentInset])

      useAnimatedReaction(() => {
        return isSlidingTopContainerValue.value !== isSlidingTopContainerPrevValue.value
          && isTopContainerOutOfSyncValue.value
      }, (res) => {
        isSlidingTopContainerPrevValue.value = isSlidingTopContainerValue.value
        if (!res || isSlidingTopContainerValue.value) {
          return
        }
        resyncTabScroll()
        isTopContainerOutOfSyncValue.value = false
      }, [tabNamesArray, refMap, contentInset])

      return (
        <Context.Provider
          value={{
            contentInset,
            tabBarHeight,
            headerHeight,
            refMap,
            tabNames,
            index,
            snapThreshold,
            revealHeaderOnScroll,
            focusedTab,
            accDiffClamp,
            indexDecimal,
            containerHeight,
            minHeaderHeight,
            scrollYCurrent,
            scrollY,
            setRef,
            headerScrollDistance,
            accScrollY,
            oldAccScrollY,
            offset,
            snappingTo,
            contentHeights,
            headerTranslateY,
            width,
            allowHeaderOverscroll,
            isSlidingTopContainerValue,
          }}
        >
          <Animated.View
            style={[styles.container, { width }, containerStyle]}
            onLayout={getContainerLayoutHeight}
            pointerEvents="box-none"
          >
            <Animated.View
              pointerEvents="box-none"
              style={[
                styles.topContainer,
                headerContainerStyle,
                !cancelTranslation && stylez,
              ]}
            >
              {/* Patched (r4 / RN 0.85): GestureDetector 不再直接包裹带
                  useAnimatedStyle transform 的 Animated.View —— gesture-handler 2.31 +
                  Fabric 下那样会导致 header 的 transform 不提交(滚动时 header 不动)。
                  transform 留在外层 Animated.View，GestureDetector 只包内层无动画手势容器。 */}
              <GestureDetector gesture={pan}>
                <View pointerEvents="box-none" style={{ width: '100%' }}>
                  <View
                    style={[styles.container, styles.headerContainer]}
                    onLayout={getHeaderHeight}
                    pointerEvents="box-none"
                  >
                    {renderHeader &&
                      renderHeader({
                        containerRef,
                        index,
                        tabNames: tabNamesArray,
                        focusedTab,
                        indexDecimal,
                        onTabPress,
                        tabProps,
                      })}
                  </View>
                  <View
                    style={[styles.container, styles.tabBarContainer]}
                    onLayout={getTabBarHeight}
                    pointerEvents="box-none"
                  >
                    {renderTabBar &&
                      renderTabBar({
                        containerRef,
                        index,
                        tabNames: tabNamesArray,
                        focusedTab,
                        indexDecimal,
                        width,
                        onTabPress,
                        tabProps,
                      })}
                  </View>
                </View>
              </GestureDetector>
            </Animated.View>

            <AnimatedPagerView
              ref={containerRef}
              onPageScroll={pageScrollHandler}
              initialPage={initialIndex}
              {...pagerProps}
              style={[pagerProps?.style, StyleSheet.absoluteFill]}
            >
              {tabNamesArray.map((tabName, i) => {
                return (
                  <View key={i} style={styles.pageContainer}>
                    <TabNameContext.Provider value={tabName}>
                      <Lazy
                        startMounted={lazy ? undefined : true}
                        cancelLazyFadeIn={!lazy ? true : !!cancelLazyFadeIn}
                        // ensure that we remount the tab if its name changes but the index doesn't
                        key={tabName}
                      >
                        {
                          React.Children.toArray(children)[
                            i
                          ] as React.ReactElement
                        }
                      </Lazy>
                    </TabNameContext.Provider>
                  </View>
                )
              })}
            </AnimatedPagerView>
          </Animated.View>
        </Context.Provider>
      )
    }
  )
)

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  pageContainer: {
    height: '100%',
    width: '100%',
  },
  topContainer: {
    position: 'absolute',
    zIndex: 100,
    width: '100%',
    backgroundColor: 'white',
    shadowColor: '#000000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.23,
    shadowRadius: 2.62,
    elevation: 4,
  },
  tabBarContainer: {
    zIndex: 1,
  },
  headerContainer: {
    zIndex: 2,
  },
})
