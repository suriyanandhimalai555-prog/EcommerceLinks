/**
 * UpgradePage — tabbed wrapper for the two management-only upgrade tools.
 *
 * Tab 1 "Package Upgrade"  → UpgradeTab (record an offline tier upgrade)
 * Tab 2 "AVG Coins"        → CoinsTab   (manually add / deduct coin balance)
 *
 * Wired at /admin/upgrade in AdminConsole.tsx (management-only route).
 */
import { useTranslation } from 'react-i18next'
import { Tabs, TabList, TabTrigger, TabContent } from '../../components/ui/Tabs'
import { UpgradeTab } from './UpgradeTab'
import { CoinsTab } from './CoinsTab'

export function UpgradePage() {
  const { t } = useTranslation()
  return (
    <Tabs defaultValue="upgrade">
      <TabList>
        <TabTrigger value="upgrade">{t('admin.upgrade.tabUpgrade')}</TabTrigger>
        <TabTrigger value="coins">{t('admin.coins.tab')}</TabTrigger>
      </TabList>
      <TabContent value="upgrade">
        <div className="mt-6">
          <UpgradeTab />
        </div>
      </TabContent>
      <TabContent value="coins">
        <div className="mt-6">
          <CoinsTab />
        </div>
      </TabContent>
    </Tabs>
  )
}
