/**
 * Token Usage Tab Component
 * Shows daily/monthly token usage and costs
 */

import { useState, useEffect } from 'react';
import { Loader2, TrendingUp, Calendar, DollarSign, RefreshCw, Users, ChevronDown, ChevronUp } from 'lucide-react';
import { adminService, type TokenUsageResponse, type TokenUsageByDay, type TokenUsageByMonth, type TokenUsageByUser } from '@/services';
import { Button } from '@/components/common/Button';
import type { AdminTranslations } from './translations';

interface TokenUsageTabProps {
  texts: AdminTranslations;
}

export function TokenUsageTab({ texts }: TokenUsageTabProps) {
  const [tokenData, setTokenData] = useState<TokenUsageResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [expandedSection, setExpandedSection] = useState<'daily' | 'monthly' | 'user' | null>('daily');

  const fetchTokenUsage = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await adminService.getTokenUsage(days);
      setTokenData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load token usage');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchTokenUsage();
  }, [days]);

  const formatCost = (cost: number) => `$${cost.toFixed(4)}`;
  const formatTokens = (tokens: number) => {
    if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(2)}M`;
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
    return tokens.toString();
  };

  if (isLoading && !tokenData) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
        <span className="ml-3 text-gray-600">{texts.loadingTokens}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded-lg">
        {error}
      </div>
    );
  }

  if (!tokenData) {
    return (
      <div className="text-center py-12 text-gray-500">
        {texts.noTokenData}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header with refresh and filter */}
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-bold text-gray-800">{texts.tokenUsage}</h2>
        <div className="flex gap-3 items-center">
          <select
            value={days}
            onChange={(e) => setDays(parseInt(e.target.value))}
            className="px-3 py-2 border rounded-lg text-sm"
          >
            <option value={7}>7 {texts.daysFilter}</option>
            <option value={14}>14 {texts.daysFilter}</option>
            <option value={30}>30 {texts.daysFilter}</option>
            <option value={90}>90 {texts.daysFilter}</option>
            <option value={365}>365 {texts.daysFilter}</option>
          </select>
          <Button
            variant="secondary"
            onClick={fetchTokenUsage}
            disabled={isLoading}
          >
            <RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} />
            {texts.refreshStats}
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-gradient-to-br from-green-50 to-emerald-50 rounded-xl p-4 border border-green-200">
          <div className="flex items-center gap-2 text-green-600 mb-2">
            <DollarSign size={20} />
            <span className="font-medium">{texts.grandTotal}</span>
          </div>
          <p className="text-3xl font-bold text-green-700">{formatCost(tokenData.costs.grandTotal)}</p>
          <p className="text-sm text-green-600 mt-1">
            {tokenData.summary.storiesWithTokenData} {texts.storiesCount}
          </p>
        </div>

        <div className="bg-gradient-to-br from-purple-50 to-indigo-50 rounded-xl p-4 border border-purple-200">
          <div className="flex items-center gap-2 text-purple-600 mb-2">
            <TrendingUp size={20} />
            <span className="font-medium">{texts.anthropic}</span>
          </div>
          <p className="text-2xl font-bold text-purple-700">{formatCost(tokenData.costs.anthropic.total)}</p>
          <p className="text-xs text-purple-600 mt-1">
            {formatTokens(tokenData.totals.anthropic.input_tokens)} in / {formatTokens(tokenData.totals.anthropic.output_tokens)} out
          </p>
        </div>

        <div className="bg-gradient-to-br from-blue-50 to-cyan-50 rounded-xl p-4 border border-blue-200">
          <div className="flex items-center gap-2 text-blue-600 mb-2">
            <TrendingUp size={20} />
            <span className="font-medium">Gemini</span>
          </div>
          <p className="text-2xl font-bold text-blue-700">
            {formatCost((tokenData.costs.gemini_text?.total || 0) + (tokenData.costs.gemini_image?.total || 0) + (tokenData.costs.gemini_quality?.total || 0) + (tokenData.costs.totalAvatarCost || 0))}
          </p>
          <p className="text-xs text-blue-600 mt-1">
            Story Images: {formatCost(tokenData.costs.gemini_image?.total || 0)} ({tokenData.totals.gemini_image?.calls || 0} calls)
          </p>
          <p className="text-xs text-blue-500 mt-0.5">
            Avatars: {formatCost(tokenData.costs.totalAvatarCost || 0)}
            {tokenData.costs.avatarByModel && Object.keys(tokenData.costs.avatarByModel).length > 0 && (
              <span className="ml-1">
                ({Object.entries(tokenData.costs.avatarByModel).map(([model, data]) =>
                  `${model.replace('gemini-', '').replace('-image', '')}: ${data.calls}`
                ).join(', ')})
              </span>
            )}
          </p>
        </div>

        <div className="bg-gradient-to-br from-orange-50 to-amber-50 rounded-xl p-4 border border-orange-200">
          <div className="flex items-center gap-2 text-orange-600 mb-2">
            <TrendingUp size={20} />
            <span className="font-medium">{texts.runware}</span>
          </div>
          <p className="text-2xl font-bold text-orange-700">{formatCost(tokenData.costs.runware.total)}</p>
          <p className="text-xs text-orange-600 mt-1">
            {tokenData.totals.runware.calls} {texts.calls}
          </p>
        </div>
      </div>

      {/* Daily Usage Table */}
      <div className="bg-white rounded-xl shadow-lg overflow-hidden">
        <button
          onClick={() => setExpandedSection(expandedSection === 'daily' ? null : 'daily')}
          className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50"
        >
          <div className="flex items-center gap-2">
            <Calendar size={20} className="text-indigo-600" />
            <span className="font-semibold text-gray-800">{texts.dailyUsage}</span>
            <span className="text-sm text-gray-500">({tokenData.byDay.length} days)</span>
          </div>
          {expandedSection === 'daily' ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
        </button>
        {expandedSection === 'daily' && (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-y">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">{texts.date}</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700">{texts.storiesCount}</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700">{texts.bookPages}</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700">{texts.anthropic}</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700">Gemini</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700">{texts.runware}</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700">{texts.totalCost}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {tokenData.byDay.slice(0, 14).map((day: TokenUsageByDay) => {
                  // Pricing per 1M tokens (Jan 2026):
                  // Claude: $3 input / $15 output
                  // Gemini 2.5 Flash (text): $0.30 input / $2.50 output
                  // Gemini Image: ~$0.035 per image
                  // Gemini 2.0 Flash (quality): $0.10 input / $0.40 output
                  const anthropicCost = ((day.anthropic?.input_tokens || 0) / 1000000) * 3 +
                                       ((day.anthropic?.output_tokens || 0) / 1000000) * 15 +
                                       ((day.anthropic?.thinking_tokens || 0) / 1000000) * 15;
                  const geminiTextCost = ((day.gemini_text?.input_tokens || 0) / 1000000) * 0.30 +
                                        ((day.gemini_text?.output_tokens || 0) / 1000000) * 2.50;
                  const geminiImageCost = (day.gemini_image?.calls || 0) * 0.035;
                  const geminiQualityCost = ((day.gemini_quality?.input_tokens || 0) / 1000000) * 0.10 +
                                           ((day.gemini_quality?.output_tokens || 0) / 1000000) * 0.40;
                  const geminiCost = geminiTextCost + geminiImageCost + geminiQualityCost;
                  const runwareCost = day.runware?.direct_cost || 0;

                  return (
                    <tr key={day.date} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-800">{day.date}</td>
                      <td className="px-4 py-3 text-sm text-right text-gray-600">{day.storyCount}</td>
                      <td className="px-4 py-3 text-sm text-right text-gray-600">{day.totalBookPages}</td>
                      <td className="px-4 py-3 text-sm text-right text-purple-600">{formatCost(anthropicCost)}</td>
                      <td className="px-4 py-3 text-sm text-right text-blue-600">{formatCost(geminiCost)}</td>
                      <td className="px-4 py-3 text-sm text-right text-orange-600">{formatCost(runwareCost)}</td>
                      <td className="px-4 py-3 text-sm text-right font-semibold text-green-700">{formatCost(day.totalCost)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Monthly Usage Table */}
      <div className="bg-white rounded-xl shadow-lg overflow-hidden">
        <button
          onClick={() => setExpandedSection(expandedSection === 'monthly' ? null : 'monthly')}
          className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50"
        >
          <div className="flex items-center gap-2">
            <Calendar size={20} className="text-indigo-600" />
            <span className="font-semibold text-gray-800">{texts.monthlyUsage}</span>
            <span className="text-sm text-gray-500">({tokenData.byMonth.length} months)</span>
          </div>
          {expandedSection === 'monthly' ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
        </button>
        {expandedSection === 'monthly' && (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-y">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">{texts.date}</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700">{texts.storiesCount}</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700">{texts.bookPages}</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700">{texts.anthropic}</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700">Gemini</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700">{texts.runware}</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700">{texts.totalCost}</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700">{texts.costPerStory}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {tokenData.byMonth.map((month: TokenUsageByMonth) => {
                  // Same pricing as daily table
                  const anthropicCost = ((month.anthropic?.input_tokens || 0) / 1000000) * 3 +
                                       ((month.anthropic?.output_tokens || 0) / 1000000) * 15 +
                                       ((month.anthropic?.thinking_tokens || 0) / 1000000) * 15;
                  const geminiTextCost = ((month.gemini_text?.input_tokens || 0) / 1000000) * 0.30 +
                                        ((month.gemini_text?.output_tokens || 0) / 1000000) * 2.50;
                  const geminiImageCost = (month.gemini_image?.calls || 0) * 0.035;
                  const geminiQualityCost = ((month.gemini_quality?.input_tokens || 0) / 1000000) * 0.10 +
                                           ((month.gemini_quality?.output_tokens || 0) / 1000000) * 0.40;
                  const geminiCost = geminiTextCost + geminiImageCost + geminiQualityCost;
                  const runwareCost = month.runware?.direct_cost || 0;
                  const costPerStory = month.storyCount > 0 ? month.totalCost / month.storyCount : 0;

                  return (
                    <tr key={month.month} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-800">{month.month}</td>
                      <td className="px-4 py-3 text-sm text-right text-gray-600">{month.storyCount}</td>
                      <td className="px-4 py-3 text-sm text-right text-gray-600">{month.totalBookPages}</td>
                      <td className="px-4 py-3 text-sm text-right text-purple-600">{formatCost(anthropicCost)}</td>
                      <td className="px-4 py-3 text-sm text-right text-blue-600">{formatCost(geminiCost)}</td>
                      <td className="px-4 py-3 text-sm text-right text-orange-600">{formatCost(runwareCost)}</td>
                      <td className="px-4 py-3 text-sm text-right font-semibold text-green-700">{formatCost(month.totalCost)}</td>
                      <td className="px-4 py-3 text-sm text-right text-gray-600">{formatCost(costPerStory)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* By User Table */}
      <div className="bg-white rounded-xl shadow-lg overflow-hidden">
        <button
          onClick={() => setExpandedSection(expandedSection === 'user' ? null : 'user')}
          className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50"
        >
          <div className="flex items-center gap-2">
            <Users size={20} className="text-indigo-600" />
            <span className="font-semibold text-gray-800">{texts.byUserUsage}</span>
            <span className="text-sm text-gray-500">({tokenData.byUser.length} users)</span>
          </div>
          {expandedSection === 'user' ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
        </button>
        {expandedSection === 'user' && (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-y">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">{texts.email}</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700">{texts.storiesCount}</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700">{texts.bookPages}</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700">{texts.anthropic}</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700">Gemini</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700">{texts.runware}</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700">{texts.costPerStory}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {tokenData.byUser.slice(0, 20).map((user: TokenUsageByUser, index: number) => {
                  // Same pricing as daily table
                  const anthropicCost = ((user.anthropic?.input_tokens || 0) / 1000000) * 3 +
                                       ((user.anthropic?.output_tokens || 0) / 1000000) * 15 +
                                       ((user.anthropic?.thinking_tokens || 0) / 1000000) * 15;
                  const geminiTextCost = ((user.gemini_text?.input_tokens || 0) / 1000000) * 0.30 +
                                        ((user.gemini_text?.output_tokens || 0) / 1000000) * 2.50;
                  const geminiImageCost = (user.gemini_image?.calls || 0) * 0.035;
                  const geminiQualityCost = ((user.gemini_quality?.input_tokens || 0) / 1000000) * 0.10 +
                                           ((user.gemini_quality?.output_tokens || 0) / 1000000) * 0.40;
                  // Calculate avatar cost per model
                  let avatarCost = 0;
                  if (user.avatarByModel) {
                    for (const modelUsage of Object.values(user.avatarByModel)) {
                      avatarCost += (modelUsage.calls || 0) * 0.035;  // ~$0.035 per avatar
                    }
                  }
                  const geminiCost = geminiTextCost + geminiImageCost + geminiQualityCost + avatarCost;
                  const runwareCost = user.runware?.direct_cost || 0;
                  const totalCost = anthropicCost + geminiCost + runwareCost;
                  const costPerStory = user.storyCount > 0 ? totalCost / user.storyCount : 0;

                  return (
                    <tr key={user.email || index} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-800">{user.email || user.name || 'Unknown'}</td>
                      <td className="px-4 py-3 text-sm text-right text-gray-600">{user.storyCount}</td>
                      <td className="px-4 py-3 text-sm text-right text-gray-600">{user.totalBookPages}</td>
                      <td className="px-4 py-3 text-sm text-right text-purple-600">{formatCost(anthropicCost)}</td>
                      <td className="px-4 py-3 text-sm text-right text-blue-600">{formatCost(geminiCost)}</td>
                      <td className="px-4 py-3 text-sm text-right text-orange-600">{formatCost(runwareCost)}</td>
                      <td className="px-4 py-3 text-sm text-right font-semibold text-green-700">{formatCost(costPerStory)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
