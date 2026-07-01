"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { useToast } from "@/hooks/use-toast"
import { Toaster } from "@/components/ui/toaster"
import { Plus, X } from "lucide-react"

const CONTRACTORS = {
  Vadim: { pin: "4826", nonColorRate: 0.25, colorRate: 0.25 },
  Denis: { pin: "7155", nonColorRate: 0.2, colorRate: 0.25 },
  Arthur: { pin: "5183", nonColorRate: 0.2, colorRate: 0.25 },
  Viktor: { pin: "3515", nonColorRate: 0.2, colorRate: 0.25 },
  Tim: { pin: "4496", nonColorRate: 0.8, colorRate: 0.8 },
  Alex: { pin: "8254", nonColorRate: 0.2, colorRate: 0.25 },
  Rodion: { pin: "8585", nonColorRate: 0.2, colorRate: 0.25 },
} as const

type ContractorName = keyof typeof CONTRACTORS

interface Job {
  id: number
  customerName: string
  date: string
  jobTotal: string
  colorSealTotal: string
  tip: string
  isCreditCard: boolean
  isCheckCash: boolean
}

const getCurrentDate = () => {
  const today = new Date()
  const month = String(today.getMonth() + 1).padStart(2, "0")
  const day = String(today.getDate()).padStart(2, "0")
  const year = String(today.getFullYear() % 100).padStart(2, "0")
  return `${month}/${day}/${year}`
}

const createEmptyJob = (id: number): Job => ({
  id,
  customerName: "",
  date: getCurrentDate(),
  jobTotal: "0",
  colorSealTotal: "0",
  tip: "0",
  isCreditCard: false,
  isCheckCash: false,
})

export default function PayoutCalculator() {
  const { toast } = useToast()

  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [selectedContractor, setSelectedContractor] = useState<string>("")
  const [pin, setPin] = useState("")
  const [stayLoggedIn, setStayLoggedIn] = useState(false)
  const [jobs, setJobs] = useState<Job[]>([createEmptyJob(1)])
  const [nextId, setNextId] = useState(2)

  useEffect(() => {
    const savedContractor = localStorage.getItem("loggedInContractor")
    if (savedContractor) {
      setSelectedContractor(savedContractor)
      setIsAuthenticated(true)
    }
  }, [])

  const showColorSeal = selectedContractor !== "Tim"

  const handleDateChange = (id: number, value: string) => {
    const digitsOnly = value.replace(/\D/g, "")
    let formatted = digitsOnly
    if (digitsOnly.length >= 2) {
      formatted = digitsOnly.slice(0, 2) + "/" + digitsOnly.slice(2)
    }
    if (digitsOnly.length >= 4) {
      formatted = digitsOnly.slice(0, 2) + "/" + digitsOnly.slice(2, 4) + "/" + digitsOnly.slice(4, 6)
    }
    updateJob(id, { date: formatted })
  }

  const parseNumber = (value: string): number => {
    const num = Number.parseFloat(value) || 0
    return num < 0 ? 0 : num
  }

  const formatCurrency = (value: number): string => `$${value.toFixed(2)}`

  const handleNumberInput = (value: string, id: number, field: keyof Job) => {
    if (value === "" || /^\d*\.?\d*$/.test(value)) {
      updateJob(id, { [field]: value })
    }
  }

  const updateJob = (id: number, fields: Partial<Job>) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...fields } : j)))
  }

  const addJob = () => {
    setJobs((prev) => [...prev, createEmptyJob(nextId)])
    setNextId((n) => n + 1)
  }

  const removeJob = (id: number) => {
    setJobs((prev) => prev.filter((j) => j.id !== id))
  }

  // Per-job payout calculation for a given contractor
  const calcJobPayout = (job: Job, contractorName: string) => {
    const rates = CONTRACTORS[contractorName as ContractorName]
    if (!rates) return { nonColorPayout: 0, colorPayout: 0, tipPayout: 0, basePayout: 0, totalPayout: 0, nonColorAmount: 0, colorAmount: 0, jobTotalNum: 0, colorSealTotalNum: 0, tipNum: 0 }

    const jobTotalNum = parseNumber(job.jobTotal)
    const colorSealTotalNum = parseNumber(job.colorSealTotal)
    const tipNum = parseNumber(job.tip)
    const nonColorAmount = showColorSeal ? jobTotalNum - colorSealTotalNum : jobTotalNum
    const colorAmount = showColorSeal ? colorSealTotalNum : 0

    const fee = job.isCreditCard ? 0.965 : 1
    const nonColorPayout = nonColorAmount * fee * rates.nonColorRate
    const colorPayout = colorAmount * fee * rates.colorRate

    let tipPayout = 0
    if (tipNum > 0) {
      const tipDivisor = contractorName === "Tim" ? 1 : 0.5
      tipPayout = tipNum * fee * tipDivisor
    }

    const basePayout = nonColorPayout + colorPayout
    const totalPayout = basePayout + tipPayout
    return { nonColorPayout, colorPayout, tipPayout, basePayout, totalPayout, nonColorAmount, colorAmount, jobTotalNum, colorSealTotalNum, tipNum }
  }

  const handleReset = () => {
    setJobs([createEmptyJob(1)])
    setNextId(2)
  }

  const copyToClipboard = (text: string) => {
    const textarea = document.createElement("textarea")
    textarea.value = text
    textarea.style.position = "fixed"
    textarea.style.top = "0"
    textarea.style.left = "0"
    textarea.style.width = "2em"
    textarea.style.height = "2em"
    textarea.style.padding = "0"
    textarea.style.border = "none"
    textarea.style.outline = "none"
    textarea.style.boxShadow = "none"
    textarea.style.background = "transparent"
    textarea.style.fontSize = "16px"
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    textarea.setSelectionRange(0, textarea.value.length)
    let success = false
    try {
      success = document.execCommand("copy")
    } catch (err) {
      // fallback failed
    }
    document.body.removeChild(textarea)
    if (success) {
      toast({ title: "Summary copied to clipboard!" })
    } else {
      toast({ title: "Failed to copy", variant: "destructive" })
    }
  }

  const buildFullSummary = (contractorName: string) => {
    const validJobsList = jobs.filter((job) => job.customerName.trim() !== "" && (job.isCreditCard || job.isCheckCash))
    if (validJobsList.length === 0) return ""
    
    const totalPayout = validJobsList.reduce((sum, job) => sum + calcJobPayout(job, contractorName).totalPayout, 0)
    
    const lines: string[] = []
    lines.push(`Contractor: ${contractorName} | Total Payout: ${formatCurrency(totalPayout)}`)
    lines.push("")
    
    validJobsList.forEach((job, index) => {
      const calc = calcJobPayout(job, contractorName)
      const paymentType = job.isCreditCard ? "Credit Card" : "Check/Cash/Zelle"
      lines.push(`Job (${index + 1}) | Customer: ${job.customerName} | Date: ${job.date} | Payment: ${paymentType} | Job: ${formatCurrency(calc.jobTotalNum)} | Color: ${formatCurrency(calc.colorSealTotalNum)} | Tip: ${formatCurrency(calc.tipNum)} | Job Payout: ${formatCurrency(calc.totalPayout)}`)
      lines.push("")
    })
    
    return lines.join("\n").trim()
  }

  const handleCopySummary = () => {
    const mySummary = buildFullSummary(selectedContractor)
    if (selectedContractor === "Vadim") {
      const denisSummary = buildFullSummary("Denis")
      const combined = mySummary + "\n\n\n\n" + denisSummary
      copyToClipboard(combined)
    } else {
      copyToClipboard(mySummary)
    }
  }

  const handleLogin = () => {
    const contractor = CONTRACTORS[selectedContractor as ContractorName]
    if (contractor && contractor.pin === pin) {
      setIsAuthenticated(true)
      if (stayLoggedIn) {
        localStorage.setItem("loggedInContractor", selectedContractor)
      }
    } else {
      toast({ title: "Invalid PIN!", variant: "destructive" })
    }
  }

  const handleLogout = () => {
    setIsAuthenticated(false)
    setPin("")
    setStayLoggedIn(false)
    localStorage.removeItem("loggedInContractor")
    handleReset()
  }

  // Compute combined totals across all valid jobs
  const validJobs = jobs.filter((j) => j.customerName.trim() !== "" && (j.isCreditCard || j.isCheckCash))
  const combinedTotal = validJobs.reduce((sum, job) => sum + calcJobPayout(job, selectedContractor).totalPayout, 0)
  const denisCombinedTotal = validJobs.reduce((sum, job) => sum + calcJobPayout(job, "Denis").totalPayout, 0)
  const anySummaryVisible = validJobs.length > 0

  if (!isAuthenticated) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center p-4">
        <Card className="w-full max-w-md shadow-xl">
          <CardHeader className="space-y-1">
            <CardTitle className="text-3xl font-bold text-center text-balance">
              <img
                src="https://hebbkx1anhila5yf.public.blob.vercel-storage.com/GB%20horrizontal%20sticker-cxlBSPuMmRNwsClisnURi1P87qCCrH.jpg"
                alt="Grout Brothers"
                className="w-full h-auto max-w-xs mx-auto"
              />
            </CardTitle>
            <CardDescription className="text-center text-base">Payout Calculator</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="contractor" className="text-base font-semibold">
                Select Contractor
              </Label>
              <Select value={selectedContractor} onValueChange={(value) => setSelectedContractor(value as ContractorName)}>
                <SelectTrigger id="contractor" className="h-14 text-lg">
                  <SelectValue placeholder="Choose your name" />
                </SelectTrigger>
                <SelectContent>
                  {Object.keys(CONTRACTORS).map((name) => (
                    <SelectItem key={name} value={name} className="text-lg py-3">
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="pin" className="text-base font-semibold">
                Enter PIN
              </Label>
              <Input
                id="pin"
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                placeholder="4-digit PIN"
                className="h-14 text-lg text-center tracking-widest"
                onKeyDown={(e) => e.key === "Enter" && handleLogin()}
              />
            </div>

            <div className="flex items-center space-x-2">
              <input
                type="checkbox"
                id="stayLoggedIn"
                checked={stayLoggedIn}
                onChange={(e) => setStayLoggedIn(e.target.checked)}
                className="w-5 h-5 rounded border-gray-300 text-primary focus:ring-primary cursor-pointer"
              />
              <Label htmlFor="stayLoggedIn" className="text-base font-medium cursor-pointer">
                Stay Logged In
              </Label>
            </div>

            <Button onClick={handleLogin} className="w-full h-14 text-lg font-semibold" size="lg">
              Login
            </Button>
          </CardContent>
        </Card>
        <Toaster />
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 p-4 pb-28">
      <div className="max-w-2xl mx-auto space-y-6 py-6">

        {/* Header */}
        <Card className="shadow-xl">
          <CardHeader className="pb-4">
            <div className="flex items-start justify-between">
              <div>
                <CardTitle className="text-2xl font-bold text-balance">Payout Calculator</CardTitle>
                <CardDescription className="text-base mt-1">Contractor: {selectedContractor}</CardDescription>
              </div>
              <div className="flex flex-col gap-2">
                <Button variant="outline" onClick={handleLogout} className="text-sm bg-transparent">
                  Logout
                </Button>
                <Button onClick={handleReset} variant="outline" className="text-sm bg-transparent">
                  Reset
                </Button>
              </div>
            </div>
          </CardHeader>
        </Card>

        {/* Job Forms */}
        {jobs.map((job, index) => {
          const jobTotalNum = parseNumber(job.jobTotal)
          const colorSealTotalNum = parseNumber(job.colorSealTotal)
          const hasError = colorSealTotalNum > jobTotalNum

          return (
            <Card key={job.id} className="shadow-xl">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg font-semibold">
                    {jobs.length > 1 ? `Job ${index + 1}` : "Job Details"}
                  </CardTitle>
                  {jobs.length > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeJob(job.id)}
                      className="text-destructive hover:text-destructive hover:bg-destructive/10 h-8 w-8 p-0"
                      aria-label="Remove job"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </CardHeader>

              <CardContent className="space-y-6">
                {/* Customer Name */}
                <div className="space-y-2">
                  <Label htmlFor={`customerName-${job.id}`} className="text-base font-semibold">
                    Customer Name <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id={`customerName-${job.id}`}
                    type="text"
                    value={job.customerName}
                    onChange={(e) => updateJob(job.id, { customerName: e.target.value })}
                    onFocus={(e) => e.target.select()}
                    placeholder="Enter customer name"
                    className="h-14 text-lg"
                  />
                </div>

                {/* Date */}
                <div className="space-y-2">
                  <Label htmlFor={`date-${job.id}`} className="text-sm text-muted-foreground">
                    Date
                  </Label>
                  <Input
                    id={`date-${job.id}`}
                    type="text"
                    inputMode="numeric"
                    maxLength={8}
                    value={job.date}
                    onChange={(e) => handleDateChange(job.id, e.target.value)}
                    onFocus={(e) => e.target.select()}
                    placeholder="MM/DD/YY"
                    className="h-10 text-base font-semibold"
                  />
                </div>

                {/* Job Total */}
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor={`jobTotal-${job.id}`} className="text-base font-semibold">
                      Job Total
                    </Label>
                    <div className="relative">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 text-2xl text-muted-foreground">$</span>
                      <Input
                        id={`jobTotal-${job.id}`}
                        type="text"
                        inputMode="decimal"
                        value={job.jobTotal}
                        onChange={(e) => handleNumberInput(e.target.value, job.id, "jobTotal")}
                        onFocus={(e) => e.target.select()}
                        className="h-16 text-2xl pl-10 pr-4 font-semibold"
                      />
                    </div>
                  </div>

                  {showColorSeal && (
                    <div className="space-y-2">
                      <Label htmlFor={`colorSeal-${job.id}`} className="text-base font-semibold">
                        Color Seal Total
                      </Label>
                      <div className="relative">
                        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-2xl text-muted-foreground">$</span>
                        <Input
                          id={`colorSeal-${job.id}`}
                          type="text"
                          inputMode="decimal"
                          value={job.colorSealTotal}
                          onChange={(e) => handleNumberInput(e.target.value, job.id, "colorSealTotal")}
                          onFocus={(e) => e.target.select()}
                          className={`h-16 text-2xl pl-10 pr-4 font-semibold ${hasError ? "border-destructive focus-visible:ring-destructive" : ""}`}
                        />
                      </div>
                      {hasError && (
                        <p className="text-sm text-destructive font-medium">Color Seal Total cannot exceed Job Total</p>
                      )}
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label htmlFor={`tip-${job.id}`} className="text-base font-semibold">
                      Tip Total
                    </Label>
                    <div className="relative">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 text-2xl text-muted-foreground">$</span>
                      <Input
                        id={`tip-${job.id}`}
                        type="text"
                        inputMode="decimal"
                        value={job.tip}
                        onChange={(e) => handleNumberInput(e.target.value, job.id, "tip")}
                        onFocus={(e) => e.target.select()}
                        className="h-16 text-2xl pl-10 pr-4 font-semibold"
                      />
                    </div>
                  </div>
                </div>

                {/* Payment Type */}
                <div className="space-y-3">
                  <Label className="text-base font-semibold">Payment Type</Label>
                  <div className="space-y-3">
                    <div className="flex items-center space-x-3 p-4 border rounded-lg bg-card hover:bg-accent/50 transition-colors">
                      <Checkbox
                        id={`creditCard-${job.id}`}
                        checked={job.isCreditCard}
                        onCheckedChange={(checked) => {
                          updateJob(job.id, { isCreditCard: !!checked, isCheckCash: checked ? false : job.isCheckCash })
                        }}
                        className="h-6 w-6"
                      />
                      <Label htmlFor={`creditCard-${job.id}`} className="text-base font-medium flex-1 cursor-pointer">
                        Credit Card
                      </Label>
                    </div>
                    <div className="flex items-center space-x-3 p-4 border rounded-lg bg-card hover:bg-accent/50 transition-colors">
                      <Checkbox
                        id={`checkCash-${job.id}`}
                        checked={job.isCheckCash}
                        onCheckedChange={(checked) => {
                          updateJob(job.id, { isCheckCash: !!checked, isCreditCard: checked ? false : job.isCreditCard })
                        }}
                        className="h-6 w-6"
                      />
                      <Label htmlFor={`checkCash-${job.id}`} className="text-base font-medium flex-1 cursor-pointer">
                        Check / Cash / Zelle
                      </Label>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )
        })}

        {/* Payout Summary */}
        {anySummaryVisible && (
          <Card className="shadow-xl bg-gradient-to-br from-primary/5 to-primary/10 border-primary/20">
            <CardHeader>
              <CardTitle className="text-xl font-bold">Payout Summary</CardTitle>
              <CardDescription className="text-base">{selectedContractor}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {validJobs.map((job, index) => {
                const calc = calcJobPayout(job, selectedContractor)
                return (
                  <div key={job.id} className="space-y-3">
                    {validJobs.length > 1 && (
                      <p className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Job {index + 1}</p>
                    )}
                    <div className="flex justify-between items-baseline pb-2 border-b">
                      <p className="text-sm text-muted-foreground">Customer</p>
                      <p className="text-lg font-semibold">{job.customerName}</p>
                    </div>
                    <div className="flex justify-between items-baseline pb-2 border-b">
                      <p className="text-sm text-muted-foreground">Date</p>
                      <p className="text-lg font-semibold">{job.date}</p>
                    </div>
                    <div className="flex justify-between items-baseline pb-2 border-b">
                      <p className="text-sm text-muted-foreground">Payment</p>
                      <p className="text-lg font-semibold">{job.isCreditCard ? "Credit Card" : "Check/Cash/Zelle"}</p>
                    </div>

                    {showColorSeal ? (
                      <>
                        <div className="flex justify-between items-baseline pb-2 border-b">
                          <div>
                            <p className="text-sm text-muted-foreground">Non-Color Portion</p>
                            <p className="text-lg font-semibold">{formatCurrency(calc.nonColorAmount)}</p>
                          </div>
                          <p className="text-xl font-bold text-primary">{formatCurrency(calc.nonColorPayout)}</p>
                        </div>
                        <div className="flex justify-between items-baseline pb-2 border-b">
                          <div>
                            <p className="text-sm text-muted-foreground">Color Portion</p>
                            <p className="text-lg font-semibold">{formatCurrency(calc.colorAmount)}</p>
                          </div>
                          <p className="text-xl font-bold text-primary">{formatCurrency(calc.colorPayout)}</p>
                        </div>
                      </>
                    ) : (
                      <div className="flex justify-between items-baseline pb-2 border-b">
                        <div>
                          <p className="text-sm text-muted-foreground">Job Total</p>
                          <p className="text-lg font-semibold">{formatCurrency(calc.jobTotalNum)}</p>
                        </div>
                        <p className="text-xl font-bold text-primary">{formatCurrency(calc.nonColorPayout)}</p>
                      </div>
                    )}

                    <div className="flex justify-between items-baseline pb-2 border-b">
                      <div>
                        <p className="text-sm text-muted-foreground">Tip Payout</p>
                        <p className="text-lg font-semibold">
                          {formatCurrency(calc.tipNum)} {selectedContractor !== "Tim" && "÷ 2"}
                        </p>
                      </div>
                      <p className="text-xl font-bold text-primary">{formatCurrency(calc.tipPayout)}</p>
                    </div>

                    <div className="flex justify-between items-baseline">
                      <p className="text-base font-semibold text-muted-foreground">Job Payout</p>
                      <p className="text-xl font-bold">{formatCurrency(calc.totalPayout)}</p>
                    </div>

                    {index < validJobs.length - 1 && <div className="border-t-2 border-primary/10 pt-2" />}
                  </div>
                )
              })}

              {/* Combined Total */}
              <div className="flex justify-between items-baseline pt-4 border-t-2 border-primary/20">
                <p className="text-xl font-bold">Total Payout</p>
                <p className="text-3xl font-bold text-primary">{formatCurrency(combinedTotal)}</p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Denis Payout Summary (Vadim only) */}
        {selectedContractor === "Vadim" && anySummaryVisible && (
          <Card className="shadow-xl bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-950 dark:to-blue-900 border-blue-300 dark:border-blue-700">
            <CardHeader>
              <CardTitle className="text-xl font-bold">Denis&apos; Payout Summary</CardTitle>
              <CardDescription className="text-base">Denis</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {validJobs.map((job, index) => {
                const calc = calcJobPayout(job, "Denis")
                return (
                  <div key={job.id} className="space-y-3">
                    {validJobs.length > 1 && (
                      <p className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Job {index + 1}</p>
                    )}
                    <div className="flex justify-between items-baseline pb-2 border-b">
                      <p className="text-sm text-muted-foreground">Customer</p>
                      <p className="text-lg font-semibold">{job.customerName}</p>
                    </div>
                    <div className="flex justify-between items-baseline pb-2 border-b">
                      <p className="text-sm text-muted-foreground">Date</p>
                      <p className="text-lg font-semibold">{job.date}</p>
                    </div>
                    <div className="flex justify-between items-baseline pb-2 border-b">
                      <p className="text-sm text-muted-foreground">Payment</p>
                      <p className="text-lg font-semibold">{job.isCreditCard ? "Credit Card" : "Check/Cash/Zelle"}</p>
                    </div>
                    <div className="flex justify-between items-baseline pb-2 border-b">
                      <div>
                        <p className="text-sm text-muted-foreground">Non-Color Portion</p>
                        <p className="text-lg font-semibold">{formatCurrency(calc.nonColorAmount)}</p>
                      </div>
                      <p className="text-xl font-bold text-blue-600 dark:text-blue-400">{formatCurrency(calc.nonColorPayout)}</p>
                    </div>
                    <div className="flex justify-between items-baseline pb-2 border-b">
                      <div>
                        <p className="text-sm text-muted-foreground">Color Portion</p>
                        <p className="text-lg font-semibold">{formatCurrency(calc.colorAmount)}</p>
                      </div>
                      <p className="text-xl font-bold text-blue-600 dark:text-blue-400">{formatCurrency(calc.colorPayout)}</p>
                    </div>
                    <div className="flex justify-between items-baseline pb-2 border-b">
                      <div>
                        <p className="text-sm text-muted-foreground">Tip Payout</p>
                        <p className="text-lg font-semibold">{formatCurrency(calc.tipNum)} ÷ 2</p>
                      </div>
                      <p className="text-xl font-bold text-blue-600 dark:text-blue-400">{formatCurrency(calc.tipPayout)}</p>
                    </div>
                    <div className="flex justify-between items-baseline">
                      <p className="text-base font-semibold text-muted-foreground">Job Payout</p>
                      <p className="text-xl font-bold">{formatCurrency(calc.totalPayout)}</p>
                    </div>
                    {index < validJobs.length - 1 && <div className="border-t-2 border-blue-200 dark:border-blue-800 pt-2" />}
                  </div>
                )
              })}

              <div className="flex justify-between items-baseline pt-4 border-t-2 border-blue-300 dark:border-blue-700">
                <p className="text-xl font-bold">Total Payout</p>
                <p className="text-3xl font-bold text-blue-600 dark:text-blue-400">{formatCurrency(denisCombinedTotal)}</p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Sticky buttons */}
      <Button
        onClick={addJob}
        className="fixed bottom-6 left-6 h-14 px-6 text-base font-semibold shadow-lg z-50"
      >
        <Plus className="h-5 w-5 mr-2" />
        Add More
      </Button>

      <Button
        onClick={handleCopySummary}
        disabled={!anySummaryVisible}
        className="fixed bottom-6 right-6 h-14 px-6 text-base font-semibold shadow-lg z-50"
      >
        Copy Summary
      </Button>

      <Toaster />
    </main>
  )
}
