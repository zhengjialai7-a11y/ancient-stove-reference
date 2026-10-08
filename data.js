const S=[
["A","汉代“延光”陶灶","汉代","陶灶明器","河南博物院","https://english.chnmus.net/webfile/sitesources/hnbwy/upload/202109/20210927163405781.jpg","https://english.chnmus.net/en/collection/details.html?id=418108026445727956","长方形灶体、灶门、灶面器具，适合研究方头灶和多火眼布局。"],
["B","东汉陶灶模型","东汉","陶灶明器","东京国立博物馆","https://www.tnm.jp/uploads/r_exhibition/exhibition/SPECIAL_LARGE_7930.jpg","https://www.tnm.jp/modules/r_exhibition/index.php?controller=item&id=7930&lang=en","带屋面式挡墙、双灶眼和正面灶门，结构清晰。"],
["C","汉代人物陶灶模型","汉代","陶灶明器","河源市博物馆","https://www.hyklbwg.com/uploads/image/2023/03/09/202303091624280812.jpg","https://www.hyklbwg.com/hbgc/index.php?cid=6&page=35&pid=79","灶上有人物、锅具与食材模型，适合参考人物与灶台尺度关系。"],
["D","汉代带烟囱陶灶","汉代","陶灶明器","焦作市博物馆相关报道","https://imagepphcloud.thepaper.cn/pph/image/181/664/562.jpg","https://m.thepaper.cn/baijiahao_16893678","矩形灶体、烟囱、多个火眼，适合研究烟道和灶面布局。"],
["E","汉代陶灶","汉代","陶灶明器","开平市博物馆","https://www.kaiping.gov.cn/attachment/0/194/194740/2372497.jpg","https://www.kaiping.gov.cn/kpswhgdlytyj/kpbwg/gzww/tq/content/post_2372497.html","长条形灶体与多件炊具，适合研究侧立面比例。"],
["F","汉灰陶灶、釜","汉代","陶灶明器","河源市博物馆","https://www.hyklbwg.com/uploads/image/2023/03/09/1678350982148712.jpg","https://www.hyklbwg.com/news/show.php?cid=18&id=2029","灶体与三件釜具并置，可参考灶面器具密度和组合。"],
["G","东汉庖厨场景画像","东汉","画像石/庖厨","汉墓庖厨图相关报道","https://q9.itc.cn/q_70/images01/20250515/05dec558be46431593dd041061d305ef.jpeg","https://www.sohu.com/a/895263486_118622","人物操作釜灶的厨房场景，适合研究烧火、烹煮和备菜动作。"],
["H","《清明上河图》茶肆局部","北宋","古画/市井","《清明上河图》相关资料","https://www.lincha.com/uploadfile/2010/0103/20100103084204874.jpg","https://www.lincha.com/chinese-tea/songdaijianchajianch-411.shtml","宋代茶肆与街市环境，可参考摊位、炉具和建筑关系。"],
["I","刘松年《撵茶图》备茶局部","南宋","古画/茶炉","台北故宫博物院藏作品相关图","https://www.teasenz.com/es/media/wysiwyg/blog/The_painting_Tea_Ceremony_by_Southern_Song_Dynasty_painter_Liu_Songnian.jpeg","https://digitalarchive.npm.gov.tw/Collection/Detail/14350?dep=P","风炉、提梁鍑、茶磨和器具组合，是宋代茶炉绘制的重要参考。"],
["J","刘松年《撵茶图》文士与备茶场景","南宋","古画/茶事","台北故宫博物院藏作品相关图","https://img1.fjdaily.com/app/images/2022-06/17/32970c90-af12-463f-99b8-2655a3f63af8.jpg","https://digitalarchive.npm.gov.tw/Collection/Detail/14350?dep=P","人物、案几、炉具关系完整，适合宋代文人生活场景构图。"],
["K","刘松年《撵茶图》茶磨与风炉局部","南宋","古画/茶炉","台北故宫博物院藏作品相关图","https://n.sinaimg.cn/sinacn15/348/w640h508/20180609/1cf4-hcscwxc1635205.jpg","https://digitalarchive.npm.gov.tw/Collection/Detail/14350?dep=P","放大后能清楚观察人物坐姿、茶磨和风炉位置。"],
["L","《五百罗汉图》茶事局部一","南宋","古画/寺院茶事","日本京都大德寺藏作品相关资料","https://k.sinaimg.cn/n/sinacn20101/363/w640h1323/20190611/993a-hyeztys5554777.jpg/w700d1q75cms.jpg","https://www.dpm.org.cn/subject_tea/single/detail/260798.html","寺院生活与茶事人物，可参考服饰、器皿和侍者动作。"],
["M","宋画罗汉茶事场景","宋代","古画/寺院茶事","宋韵迹忆资料页","https://z.hangzhou.com.cn/2022/syjy/images/2022-12/09/24621033-898d-4b2b-9d7b-3e95935c8469.jpg","https://z.hangzhou.com.cn/2022/syjy/content/content_8421771.html","人物端茶、研磨与室内家具关系清晰。"],
["N","《五百罗汉图》人物局部","南宋","古画/人物","日本京都大德寺藏作品相关资料","https://trueart-content.oss-cn-shanghai.aliyuncs.com/20190511/041703990_640.jpg","https://www.trueart.com/news/220639.html","用于补充宋代人物服装、色彩和寺院场景气氛。"]
];
const F={
A:[["整体三分之二视角","50% 50%",1],["正面灶门","20% 65%",1.45],["灶面火眼","48% 28%",1.35],["锅具与灶面","66% 24%",1.4]],
B:[["整体结构","50% 50%",1],["双灶眼","47% 48%",1.4],["正面灶门","72% 70%",1.55],["后部挡墙与屋面","54% 22%",1.35]],
C:[["整体人物灶","50% 50%",1],["灶门与前部","25% 66%",1.5],["人物操作锅具","42% 28%",1.55],["灶面器皿","68% 30%",1.45]],
D:[["整体与烟囱","50% 50%",1],["烟囱","21% 18%",1.65],["灶面火眼","50% 30%",1.5],["灶体侧立面","54% 68%",1.35]],
E:[["侧立面全貌","50% 50%",1],["灶面器具组合","53% 33%",1.4],["后部上翘结构","88% 40%",1.65]],
F:[["整体组合","50% 50%",1],["灶门","15% 58%",1.6],["三件釜具","57% 33%",1.45]],
G:[["庖厨场景全貌","50% 50%",1],["煮釜人物","63% 47%",1.55],["灶火与釜底","61% 71%",1.75]],
H:[["宋代茶肆全景","50% 50%",1],["店内炉具区","57% 54%",1.6],["街边摊位关系","70% 65%",1.45]],
I:[["《撵茶图》备茶整体","50% 50%",1],["风炉与提梁鍑","48% 60%",1.55],["茶磨人物","22% 65%",1.55],["桌面茶具","51% 37%",1.45],["站立侍者","76% 45%",1.5]],
J:[["文士茶会整体","50% 50%",1],["左侧备茶区","18% 55%",1.6],["文士与案几","70% 55%",1.45]],
K:[["茶磨与人物","45% 55%",1],["茶磨细节","62% 67%",1.55],["后方风炉","81% 22%",1.45]],
L:[["罗汉茶事整体","50% 50%",1],["侍者与器具","62% 58%",1.45],["人物服饰","42% 42%",1.55]],
M:[["寺院茶事整体","50% 50%",1],["端茶僧人","38% 52%",1.55],["研磨侍者","72% 68%",1.55],["家具与器物","65% 35%",1.45]],
N:[["罗汉人物整体","50% 50%",1],["服饰配色","52% 50%",1.45],["手持器皿人物","25% 55%",1.6],["人物神态局部","65% 43%",1.55]]
};
let id=1,D=[];
for(const s of S){for(const f of F[s[0]]){D.push({id:id++,title:s[1]+" · "+f[0],base_title:s[1],era:s[2],type:s[3],institution:s[4],image:s[5],source:s[6],focus:f[0],position:f[1],scale:f[2],note:s[7],tags:[s[2],s[3].split("/")[0],"灶台参考",f[0]]})}}
window.REFERENCE_DATA=D.slice(0,50);