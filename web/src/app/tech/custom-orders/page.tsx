'use client'

/**
 * Персональные заказы в кабинете внедренца.
 *
 * ⚠️ Экран ОБЩИЙ с админкой (`CustomOrdersScreen`). Отличия:
 *   • видны ТОЛЬКО свои заказы — фильтр по tech_specialist_id стоит в SQL,
 *     а не в интерфейсе;
 *   • удалять нельзя (метода `remove` в наборе нет): заказ — след денег
 *     компании, убрать его может только владелец.
 */
import { api } from '@/lib/api'
import CustomOrdersScreen from '@/components/CustomOrdersScreen'

export default function TechCustomOrdersPage() {
  return <CustomOrdersScreen api={api.techCustomOrders} />
}
